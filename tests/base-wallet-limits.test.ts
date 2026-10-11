import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { decodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_WALLET_LIMITS_SQL,
  BASE_WALLET_VAULT_SQL,
  baseWalletLimitsMigration,
  registerBaseMigration,
} from '../server/base/schema.js';
import { listMigrations } from '../server/migrations.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import type {
  PermissionChainState,
  PermissionReader,
} from '../server/base/chain/permission-reader.js';
import { OwnerRevokeError, type OwnerRevokePort } from '../server/base/chain/owner-revoke.js';
import type { StoredOperation } from '../server/base/chain/submit.js';
import { agentWalletRecipe, deriveAddressLocal } from '../server/base/chain/derive.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import { ownerTypedData } from '../server/base/chain/permissions.js';
import type { Address } from '../shared/base/chains.js';
import { WALLET_CHAIN_ID as CHAIN_ID } from '../shared/base/wallet-network.js';
import type { SpendPermission } from '../shared/base/types.js';
import {
  LIMIT_PERIOD_SECONDS,
  LIMIT_PERMISSION_END,
  checkRevokeOperation,
  nextBerlinMidnight,
  permissionFromJson,
  permissionToJson,
  spendPermissionHash,
  type RpcUserOperation,
} from '../shared/base/spend-limits.js';
import {
  checkLimit as clientCheckLimit,
  checkRevoke as clientCheckRevoke,
} from '../src/base/wallet/limits.js';
import { WALLET_EXPECTED, WALLET_NET, WALLET_ON } from './wallet-network-fixture.js';

/** The wallet network (shared/base/wallet-network.ts): Base Sepolia or Base. */
const NETWORK = WALLET_NET;
const SPM = NETWORK.contracts.spendPermissionManager;
const USDC = NETWORK.tokens.USDC.address;
const AGENT = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const AI_AGENT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const OUTSIDE_AGENT = '2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e';
const SPENDER = getAddress(`0x${'3'.repeat(40)}`);
// Saturday 10 Oct 2026, 14:00 in Berlin (CEST).
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 10, 22, 0, 0) / 1000; // Sunday 11 Oct, 00:00 Berlin
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const json = { 'content-type': 'application/json' };
const as = (person?: string, workspace?: string) => ({
  ...json,
  ...(person ? { 'x-test-person': person } : {}),
  ...(workspace ? { 'x-city-workspace': workspace } : {}),
});

const executeAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const wrapperParams = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint8' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
] as const;

interface Options {
  env?: Record<string, string | undefined>;
  backup?: boolean;
  /** No Base reader configured at all. */
  noReader?: boolean;
}

/** Base as the fake reader shows it: per permission hash, at head and at the settled block. */
function fakeBase() {
  const chain = {
    fail: false,
    head: 1_000n,
    settled: 997n,
    time: NOW / 1000,
    deployed: false,
    approved: new Set<string>(),
    revokedHead: new Set<string>(),
    revokedSettled: new Set<string>(),
    spend: new Map<string, bigint>(),
    reads: [] as Array<{ settled: boolean; count: number }>,
  };
  const reader: PermissionReader = {
    async read(permissions, options = {}) {
      const settled = options.settled === true;
      chain.reads.push({ settled, count: permissions.length });
      if (chain.fail) throw new Error('transport down');
      return {
        blockNumber: settled ? chain.settled : chain.head,
        blockTimestamp: chain.time,
        permissions: permissions.map((p): PermissionChainState => {
          const hash = spendPermissionHash(CHAIN_ID, p);
          const phase =
            chain.time < p.start ? 'before_start' : chain.time >= p.end ? 'ended' : 'active';
          const periodStart = p.start + Math.floor((chain.time - p.start) / p.period) * p.period;
          return {
            approved: chain.approved.has(hash),
            revoked: (settled ? chain.revokedSettled : chain.revokedHead).has(hash),
            phase,
            current:
              phase === 'active'
                ? {
                    start: periodStart,
                    end: periodStart + p.period,
                    spend: chain.spend.get(hash) ?? 0n,
                  }
                : null,
          };
        }),
      };
    },
    async deployed() {
      if (chain.fail) throw new Error('transport down');
      return chain.deployed;
    },
  };
  return { chain, reader };
}

/** The owner-operation port with Base behind it faked: it records what it was asked to do. */
function fakeOperations() {
  const ops = {
    fail: null as OwnerRevokeError | null,
    /** The process stops inside the next submit: before or after the chain store kept it. */
    crash: null as null | 'before-store' | 'after-store',
    status: 'submitted' as StoredOperation['status'],
    prepared: [] as Array<Parameters<OwnerRevokePort['prepare']>[0]>,
    submitted: [] as Array<Parameters<OwnerRevokePort['submit']>[0]>,
    refreshed: [] as string[],
    stored: new Map<string, StoredOperation>(),
  };
  const hashOf = (operation: UserOperation<'0.6'>) =>
    getUserOperationHash({
      chainId: CHAIN_ID,
      entryPointAddress: NETWORK.contracts.entryPointV06,
      entryPointVersion: '0.6',
      userOperation: operation,
    });
  const port: OwnerRevokePort = {
    chainId: CHAIN_ID,
    entryPoint: NETWORK.contracts.entryPointV06,
    async prepare(input) {
      ops.prepared.push(input);
      if (ops.fail) throw ops.fail;
      const [call] = input.calls;
      const operation: UserOperation<'0.6'> = {
        sender: input.wallet,
        nonce: BigInt(ops.prepared.length),
        initCode: '0x',
        callData: encodeFunctionData({
          abi: executeAbi,
          functionName: 'execute',
          args: [call.target, call.value, call.data],
        }),
        callGasLimit: 100_000n,
        verificationGasLimit: 200_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 2_000_000n,
        maxPriorityFeePerGas: 1_000n,
        // The pinned sponsor's layout (shared/base/paymasters.ts) with a synthetic paymaster, so the
        // browser's check can run on it with its own allowlist (keyed by the wallet network).
        paymasterAndData: `0x${'7a'.repeat(20)}${'00'.repeat(109)}${'ab'.repeat(65)}`,
        signature: '0x',
      };
      return { operation, userOpHash: hashOf(operation), maxCostWei: 1n, deployed: true };
    },
    async submit(input) {
      ops.submitted.push(input);
      if (ops.fail) throw ops.fail;
      const crash = ops.crash;
      ops.crash = null;
      if (crash === 'before-store') throw new Error('process stopped');
      const row: StoredOperation = {
        idempotencyKey: input.idempotencyKey,
        intentHash: input.intentHash,
        chainId: CHAIN_ID,
        kind: 'userop',
        sender: input.wallet,
        signer: input.owner,
        nonce: input.operation.nonce.toString(10),
        userOpHash: input.userOpHash,
        signedOperation: '{}',
        status: ops.status,
        txHash: null,
        blockNumber: null,
        gasUsed: null,
        feeWei: null,
        maxCostWei: '1',
        submittedBlock: '1000',
        errorCode: null,
      };
      if (!ops.stored.has(input.idempotencyKey)) ops.stored.set(input.idempotencyKey, row);
      if (crash === 'after-store') throw new Error('process stopped');
      return ops.stored.get(input.idempotencyKey)!;
    },
    async refresh(key) {
      ops.refreshed.push(key);
      const row = ops.stored.get(key);
      return row ? { ...row, status: ops.status } : null;
    },
  };
  return { ops, port };
}

async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: Options = {}) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('ai-1','ai');
    CREATE TABLE agent_manifests (agent_id text, operator_id text, revision integer, manifest jsonb);
    INSERT INTO agent_manifests VALUES ('${AGENT}', 'person-1', 1, '{}'),
      ('${AI_AGENT}', 'ai-1', 1, '{}'), ('${OUTSIDE_AGENT}', 'person-1', 1, '{}');`);
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_WALLET_VAULT_SQL);
  await pg.exec(BASE_WALLET_LIMITS_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  await pg.query(
    `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
       cipher_params, version, backup_confirmed_at, created_at, updated_at)
     VALUES ('person-1', $1, decode(repeat('ab', 48), 'hex'), '{}', '{}', 1, $2, 1, 1)`,
    [owner.address, options.backup === false ? null : 1],
  );
  const wallets: Record<string, Address> = {};
  const insertWallet = async (
    id: string,
    agent: string,
    workspace: string,
    account: string | null,
  ) => {
    // As W1 makes them: the agent's own account index (the browser derives the wallet from it).
    const recipe = agentWalletRecipe(NETWORK, owner.address, accountIndexFor(agent));
    const address = deriveAddressLocal(recipe);
    wallets[agent] = address;
    await pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1,$2,$3,${CHAIN_ID},$4,$5,$6,'v1:k',$7,'derived',0,0,$8)`,
      [
        id,
        agent,
        workspace,
        address,
        owner.address,
        SPENDER,
        JSON.stringify({
          version: 1,
          owners: recipe.owners,
          factory: recipe.factory,
          implementationVersion: 'test',
          accountIndex: recipe.index.toString(10),
        }),
        account,
      ],
    );
  };
  await insertWallet('w-1', AGENT, 'person-1', 'person-1');
  // An agent of a co-owned AI workspace whose wallet person-1 owns.
  await insertWallet('w-ai', AI_AGENT, 'ai-1', 'person-1');
  // A wallet with an outside owner (no vault account): never operable here.
  await insertWallet('w-out', OUTSIDE_AGENT, 'person-1', null);

  const base = fakeBase();
  const { ops, port } = fakeOperations();
  const clock = { now: NOW };
  const coOwned = new Set(['person-1:ai-1', 'person-2:ai-1']);
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env: options.env ?? WALLET_ON,
    currentPerson: async (request) => {
      const who = request.headers['x-test-person'];
      return typeof who === 'string' ? { id: who } : null;
    },
    currentWorkspace: async (request) => {
      const who = request.headers['x-test-person'] as string;
      const selected = request.headers['x-city-workspace'];
      if (typeof selected !== 'string' || selected === who) return { id: who };
      if (coOwned.has(`${who}:${selected}`)) return { id: selected };
      throw Object.assign(new Error('Workspace not found.'), { statusCode: 404 });
    },
    runtime: async () => ({}) as ChainRuntime,
    permissions: options.noReader ? undefined : base.reader,
    limitOperations: async () => port,
    now: () => clock.now,
  });
  return { app, pg, owner, wallets, chain: base.chain, ops, clock };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const limitsUrl = (agent = AGENT) => `/api/base/agents/${agent}/wallet/limits`;

async function prepare(
  f: Fixture,
  body: unknown = { capRaw: '20000000', period: 'day' },
  person = 'person-1',
  agent = AGENT,
) {
  return f.app.inject({
    method: 'POST',
    url: `${limitsUrl(agent)}/prepare`,
    headers: as(person),
    payload: JSON.stringify(body),
  });
}

interface Prepared {
  permission: ReturnType<typeof permissionToJson>;
  permissionHash: Hex;
  typedData: ReturnType<typeof ownerTypedData>;
  capRaw: string;
  period: 'day' | 'week' | 'month';
  allowanceRaw: string;
  onchainModel: string;
}

async function store(
  f: Fixture,
  prepared: Prepared,
  overrides: {
    signer?: PrivateKeyAccount;
    permission?: object;
    signedPermission?: SpendPermission;
    capRaw?: string;
    person?: string;
  } = {},
) {
  const signer = overrides.signer ?? f.owner;
  const signedFor = overrides.signedPermission;
  const typedData = signedFor
    ? ownerTypedData(CHAIN_ID, signedFor.account, spendPermissionHash(CHAIN_ID, signedFor))
    : prepared.typedData;
  const signature = await signer.signTypedData(typedData);
  return f.app.inject({
    method: 'POST',
    url: limitsUrl(),
    headers: as(overrides.person ?? 'person-1'),
    payload: JSON.stringify({
      permission: overrides.permission ?? prepared.permission,
      capRaw: overrides.capRaw ?? prepared.capRaw,
      period: prepared.period,
      signature,
    }),
  });
}

async function storedLimit(f: Fixture, body?: unknown) {
  const res = await prepare(f, body);
  assert.equal(res.statusCode, 200, res.body);
  const prepared = res.json() as Prepared;
  const created = await store(f, prepared);
  assert.equal(created.statusCode, 201, created.body);
  return { prepared, created: created.json() };
}

const list = async (f: Fixture, person = 'person-1', agent = AGENT) => {
  const res = await f.app.inject({ url: limitsUrl(agent), headers: as(person) });
  return res;
};

test('migration 90 is registered after 88 and only adds to base_spend_permissions', () => {
  assert.equal(nextBerlinMidnight(NOW), MIDNIGHT);
  registerBaseMigration();
  const versions = listMigrations().map((m) => m.version);
  assert.ok(versions.includes(90));
  assert.ok(versions.indexOf(90) > versions.indexOf(88));
  assert.equal(baseWalletLimitsMigration.name, 'base_wallet_limits');
  assert.doesNotMatch(BASE_WALLET_LIMITS_SQL, /DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);
});

test('with the flag off every limit route is 404', async (t) => {
  const f = await setup(t, { env: {} });
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [method, url] of [
    ['GET', limitsUrl()],
    ['POST', `${limitsUrl()}/prepare`],
    ['POST', limitsUrl()],
    ['POST', `${limitsUrl()}/${id}/revoke`],
    ['POST', `${limitsUrl()}/${id}/revoke/signature`],
  ] as const) {
    const res = await f.app.inject({ method, url, headers: as('person-1'), payload: '{}' });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
});

test('half model: prepare, sign in the browser, store; ERC-6492 while undeployed', async (t) => {
  const f = await setup(t);
  const res = await prepare(f);
  assert.equal(res.statusCode, 200, res.body);
  const prepared = res.json();
  // The default model: Base allows half the cap per Base day, so a burst across midnight stays
  // within the cap the owner chose.
  assert.equal(prepared.onchainModel, 'half');
  assert.equal(prepared.capRaw, '20000000');
  assert.equal(prepared.capDisplay, '20');
  assert.equal(prepared.allowanceRaw, '10000000');
  assert.equal(prepared.allowanceDisplay, '10');
  assert.equal(prepared.boundaryBurstRaw, '20000000');
  assert.equal(prepared.periodSeconds, 86_400);
  const permission = permissionFromJson(prepared.permission)!;
  assert.equal(permission.account, f.wallets[AGENT]);
  assert.equal(permission.spender, SPENDER);
  assert.equal(permission.token, getAddress(USDC));
  assert.equal(permission.allowance, 10_000_000n);
  assert.equal(permission.period, LIMIT_PERIOD_SECONDS.day);
  assert.equal(permission.start, MIDNIGHT);
  assert.equal(permission.end, LIMIT_PERMISSION_END);
  assert.equal(permission.extraData, '0x');
  // What the browser recomputes before signing: the hash and the wallet wrapper around it.
  const hash = spendPermissionHash(CHAIN_ID, permission);
  assert.equal(prepared.permissionHash, hash);
  assert.deepEqual(
    prepared.typedData,
    JSON.parse(JSON.stringify(ownerTypedData(CHAIN_ID, f.wallets[AGENT], hash))),
  );

  const created = await store(f, prepared);
  assert.equal(created.statusCode, 201, created.body);
  const limit = created.json();
  assert.equal(limit.state, 'signed');
  assert.equal(limit.capRaw, '20000000');
  assert.equal(limit.allowanceRaw, '10000000');
  assert.equal(limit.onchainModel, 'half');
  assert.equal(limit.start, MIDNIGHT);
  // A retry of the same signed limit is answered with the stored one, never a second row.
  const retried = await store(f, prepared);
  assert.equal(retried.statusCode, 201, retried.body);
  assert.equal(retried.json().permissionId, limit.permissionId);

  const { rows } = await f.pg.query<{
    signature: string;
    state: string;
    token: string;
    permission_hash: string;
    period_kind: string;
    cap_raw: string;
    onchain_model: string;
    owner_account_id: string;
  }>(
    `SELECT encode(signature, 'hex') AS signature, state, token, permission_hash, period_kind,
       cap_raw::text AS cap_raw, onchain_model, owner_account_id FROM base_spend_permissions`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'signed');
  assert.equal(rows[0].token, USDC.toLowerCase());
  assert.equal(rows[0].permission_hash, hash.toLowerCase());
  assert.equal(rows[0].period_kind, 'day');
  assert.equal(rows[0].cap_raw, '20000000');
  assert.equal(rows[0].onchain_model, 'half');
  assert.equal(rows[0].owner_account_id, 'person-1');
  // Undeployed: ERC-6492 around the SignatureWrapper, deploying with the wallet's own recipe.
  assert.ok(rows[0].signature.endsWith(ERC6492_SUFFIX));
  const body = `0x${rows[0].signature.slice(0, -64)}` as Hex;
  const [factory, , inner] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
    body,
  );
  assert.equal(factory, NETWORK.contracts.smartWalletFactory);
  const [wrapper] = decodeAbiParameters(wrapperParams, inner);
  assert.equal(wrapper.ownerIndex, 0);
  assert.equal(
    wrapper.signatureData,
    await f.owner.signTypedData(ownerTypedData(CHAIN_ID, f.wallets[AGENT], hash)),
  );

  const audit = await f.pg.query<{ kind: string; detail: Record<string, unknown> }>(
    `SELECT kind, detail FROM base_audit_events WHERE kind = 'limit_signed'`,
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].detail.erc6492, true);
  assert.equal(audit.rows[0].detail.onchainModel, 'half');
  assert.doesNotMatch(JSON.stringify(audit.rows), new RegExp(wrapper.signatureData.slice(2, 40)));
});

test('full model: the allowance is the cap and the view says so', async (t) => {
  const f = await setup(t, {
    env: { CITY_BASE_WALLET: '1', CITY_BASE_LIMIT_ONCHAIN_MODEL: 'full' },
  });
  const { prepared, created } = await storedLimit(f, { capRaw: '20000000', period: 'week' });
  assert.equal(prepared.onchainModel, 'full');
  assert.equal(prepared.allowanceRaw, '20000000');
  assert.equal(created.allowanceRaw, '20000000');
  assert.equal(created.boundaryBurstRaw, '40000000');
  assert.equal(created.periodSeconds, 604_800);
  const view = (await list(f)).json();
  // On the wallet network, named as such.
  assert.deepEqual(
    [view.chainId, view.network, view.testnet],
    [WALLET_EXPECTED.chainId, WALLET_EXPECTED.name, WALLET_EXPECTED.testnet],
  );
  assert.equal(view.onchainModel, 'full');
  assert.equal(view.limits[0].onchainModel, 'full');
  assert.equal(view.limits[0].capRaw, '20000000');
  assert.equal(view.limits[0].allowanceRaw, '20000000');
  // One unit is a valid cap in the full model; in the half model it leaves no allowance.
  const tiny = await setup(t);
  const refused = await prepare(tiny, { capRaw: '1', period: 'day' });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, 'invalid_cap');
  const monthly = await prepare(tiny, { capRaw: '3', period: 'month' });
  assert.equal(monthly.statusCode, 200);
  assert.equal(monthly.json().allowanceRaw, '1');
  assert.equal(monthly.json().periodSeconds, 2_678_400);
});

test('a deployed wallet gets the plain SignatureWrapper, no ERC-6492', async (t) => {
  const f = await setup(t);
  f.chain.deployed = true;
  await storedLimit(f);
  const { rows } = await f.pg.query<{ signature: string }>(
    `SELECT encode(signature, 'hex') AS signature FROM base_spend_permissions`,
  );
  assert.ok(!rows[0].signature.endsWith(ERC6492_SUFFIX));
  const [wrapper] = decodeAbiParameters(wrapperParams, `0x${rows[0].signature}` as Hex);
  assert.equal(wrapper.ownerIndex, 0);
});

test('wrong signer, tampered permission and a wrong cap are refused with 422', async (t) => {
  const f = await setup(t);
  const prepared = (await prepare(f)).json() as Prepared;
  const permission = permissionFromJson(prepared.permission)!;

  // Someone else's key.
  const stranger = privateKeyToAccount(generatePrivateKey());
  const wrong = await store(f, prepared, { signer: stranger });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, 'signature_mismatch');

  // Allowance raised after the owner signed: the signature no longer matches it.
  const raised = { ...prepared.permission, allowance: '20000000' };
  const raisedRes = await store(f, prepared, { permission: raised, capRaw: '40000000' });
  assert.equal(raisedRes.statusCode, 422);
  assert.equal(raisedRes.json().code, 'signature_mismatch');

  // The owner tricked into signing for another spender: not what the server builds.
  const attacker = getAddress(`0x${'9'.repeat(40)}`);
  const swapped = { ...permission, spender: attacker };
  const swappedRes = await store(f, prepared, {
    permission: permissionToJson(swapped),
    signedPermission: swapped,
  });
  assert.equal(swappedRes.statusCode, 422);
  assert.equal(swappedRes.json().code, 'permission_mismatch');

  // A start that is not the next Berlin midnight, an end, a period or extra data of its own.
  for (const change of [
    { start: MIDNIGHT - 3600 },
    { start: MIDNIGHT + 86_400 },
    { end: MIDNIGHT + 30 * 86_400 },
    { period: 3600 },
    { extraData: '0x01' as Hex },
    { token: NETWORK.tokens.ETH.address },
    { account: getAddress(`0x${'4'.repeat(40)}`) },
  ]) {
    const changed = { ...permission, ...change };
    const res = await store(f, prepared, {
      permission: permissionToJson(changed),
      signedPermission: changed,
    });
    assert.equal(res.statusCode, 422, JSON.stringify(change));
    assert.equal(res.json().code, 'permission_mismatch');
  }

  // A cap that does not give this allowance under the model (half of 30 is 15, not 10).
  const capRes = await store(f, prepared, { capRaw: '30000000' });
  assert.equal(capRes.statusCode, 422);
  assert.equal(capRes.json().code, 'permission_mismatch');

  // Malformed bodies are 400.
  for (const payload of [
    {},
    { ...prepared, signature: '0x12' },
    {
      permission: { ...prepared.permission, allowance: 5 },
      capRaw: '1',
      period: 'day',
      signature: `0x${'1'.repeat(130)}`,
    },
  ]) {
    const res = await f.app.inject({
      method: 'POST',
      url: limitsUrl(),
      headers: as('person-1'),
      payload: JSON.stringify(payload),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 80));
  }

  // Nothing was stored, and the honest one still goes through.
  const none = await f.pg.query('SELECT 1 FROM base_spend_permissions');
  assert.equal(none.rows.length, 0);
  assert.equal((await store(f, prepared)).statusCode, 201);
  // Signed just before midnight and sent just after: the start that was prepared still counts.
  const late = await setup(t);
  late.clock.now = Date.UTC(2026, 9, 10, 21, 55);
  const preparedLate = (await prepare(late)).json() as Prepared;
  late.clock.now = Date.UTC(2026, 9, 10, 22, 3);
  assert.equal((await store(late, preparedLate)).statusCode, 201);
});

test('one active limit per token; a new one only after Base shows the old one revoked', async (t) => {
  const f = await setup(t);
  const { prepared, created } = await storedLimit(f);
  const again = await prepare(f);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'limit_exists');
  assert.equal(again.json().permissionId, created.permissionId);

  // A second limit signed for another salt is refused too (no stacking).
  const first = permissionFromJson(prepared.permission)!;
  const second = { ...first, salt: first.salt + 1n };
  const stacked = await store(f, prepared, {
    permission: permissionToJson(second),
    signedPermission: second,
  });
  assert.equal(stacked.statusCode, 409);
  assert.equal(stacked.json().code, 'limit_exists');

  // Revoke requested: the agent is blocked at once, but a new limit still waits for Base.
  const revoke = await f.app.inject({
    method: 'POST',
    url: `${limitsUrl()}/${created.permissionId}/revoke`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  const state = await f.pg.query<{ state: string }>('SELECT state FROM base_spend_permissions');
  assert.equal(state.rows[0].state, 'revoke_pending');
  const waiting = await prepare(f);
  assert.equal(waiting.statusCode, 409);
  assert.equal(waiting.json().code, 'limit_exists');
  assert.equal(waiting.json().state, 'revoke_pending');

  // Revoked at head is not proof yet (it could reorg); only the settled read is.
  f.chain.revokedHead.add(created.permissionHash);
  assert.equal((await prepare(f)).statusCode, 409);
  f.chain.revokedSettled.add(created.permissionHash);
  const fresh = await prepare(f);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.ok(f.chain.reads.some((read) => read.settled));
  const revoked = await f.pg.query<{ state: string; revoked_block: string }>(
    'SELECT state, revoked_block::text AS revoked_block FROM base_spend_permissions',
  );
  assert.equal(revoked.rows[0].state, 'revoked');
  assert.equal(revoked.rows[0].revoked_block, '997');
  assert.equal((await store(f, fresh.json())).statusCode, 201);
  // The database itself never holds two open limits for one token.
  await assert.rejects(
    f.pg.query(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
         signature, state, token, permission_hash, created_at, updated_at)
       VALUES ('dup','w-1',${CHAIN_ID},'{}','\\x00','signed',$1,$2,0,0)`,
      [USDC.toLowerCase(), `0x${'7'.repeat(64)}`],
    ),
  );
});

test('revoke: two-phase, the owner signs the raw userOpHash, revoked only from a Base read', async (t) => {
  const f = await setup(t);
  const { prepared, created } = await storedLimit(f);
  const permission = permissionFromJson(prepared.permission)!;
  const revokeUrl = `${limitsUrl()}/${created.permissionId}/revoke`;

  const res = await f.app.inject({
    method: 'POST',
    url: revokeUrl,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(res.statusCode, 200, res.body);
  const request = res.json();
  assert.equal(request.state, 'revoke_pending');
  assert.equal(request.revokeState, 'awaiting_signature');
  assert.equal(request.summary.action, 'revoke_limit');
  assert.equal(request.summary.contract, SPM);
  assert.equal(request.expiresAt, NOW + 10 * 60_000);
  // What the browser checks before signing: the wallet's own SpendPermissionManager.revoke of
  // exactly this limit, and the hash of exactly this operation.
  const userOpHash = checkRevokeOperation(CHAIN_ID, request.userOperation as RpcUserOperation, {
    wallet: f.wallets[AGENT],
    permission,
  });
  assert.equal(userOpHash, request.userOpHash);
  assert.throws(() =>
    checkRevokeOperation(CHAIN_ID, request.userOperation, {
      wallet: f.wallets[AGENT],
      permission: { ...permission, salt: 1n },
    }),
  );
  assert.equal(f.ops.prepared[0].wallet, f.wallets[AGENT]);
  assert.equal(f.ops.prepared[0].calls[0].target, SPM);

  // Asking again while unsigned hands back the same operation.
  const same = await f.app.inject({
    method: 'POST',
    url: revokeUrl,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(same.json().userOpHash, request.userOpHash);
  assert.equal(f.ops.prepared.length, 1);

  const sign = (signature: Hex, person = 'person-1') =>
    f.app.inject({
      method: 'POST',
      url: `${revokeUrl}/signature`,
      headers: as(person),
      payload: JSON.stringify({ signature }),
    });
  // A typed-data or message signature is not a signature over the raw hash.
  const stranger = privateKeyToAccount(generatePrivateKey());
  const wrong = await sign(await stranger.sign({ hash: request.userOpHash }));
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, 'signature_mismatch');
  const prefixed = await sign(await f.owner.signMessage({ message: { raw: request.userOpHash } }));
  assert.equal(prefixed.statusCode, 422);
  assert.equal(f.ops.submitted.length, 0);

  const signature = await f.owner.sign({ hash: request.userOpHash });
  const sent = await sign(signature);
  assert.equal(sent.statusCode, 202, sent.body);
  assert.equal(sent.json().revoke.state, 'submitted');
  assert.equal(f.ops.submitted.length, 1);
  const submitted = f.ops.submitted[0];
  assert.equal(submitted.idempotencyKey, `base-wallet:limit-revoke:${created.permissionId}:1`);
  assert.equal(submitted.owner, f.owner.address);
  assert.equal(submitted.signature, signature);
  assert.equal(submitted.userOpHash, request.userOpHash);
  assert.equal(submitted.wallet, f.wallets[AGENT]);

  // While it is on its way nothing new is prepared.
  const busy = await f.app.inject({
    method: 'POST',
    url: revokeUrl,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'revoke_in_progress');

  // The view: still revoke_pending (Base has not shown it revoked), the operation followed.
  let view = (await list(f)).json();
  assert.equal(view.limits[0].state, 'revoke_pending');
  assert.equal(view.limits[0].revoke.state, 'submitted');
  assert.equal(view.limits[0].calendar.leftRaw, '0');
  assert.ok(f.ops.refreshed.includes(submitted.idempotencyKey));

  // Final on Base, but the read at the settled block decides.
  f.ops.status = 'final';
  f.chain.revokedHead.add(created.permissionHash);
  view = (await list(f)).json();
  assert.equal(view.limits[0].state, 'revoke_pending');
  assert.equal(view.limits[0].onchain.revoked, true);
  assert.equal(view.limits[0].onchain.leftRaw, '0');
  f.chain.revokedSettled.add(created.permissionHash);
  view = (await list(f)).json();
  assert.equal(view.limits[0].state, 'revoked');
  assert.equal(view.limits[0].revoke.state, 'final');
  assert.equal(view.limits[0].revoke.revokedAtBlock, 997);

  const kinds = (
    await f.pg.query<{ kind: string }>('SELECT kind FROM base_audit_events ORDER BY event_id')
  ).rows.map((row) => row.kind);
  assert.deepEqual(kinds, [
    'limit_signed',
    'limit_revoke_requested',
    'limit_revoke_prepared',
    'limit_revoke_signed',
    'limit_revoke_submitted',
    'limit_revoked',
  ]);
  const details = JSON.stringify((await f.pg.query('SELECT detail FROM base_audit_events')).rows);
  assert.doesNotMatch(details, new RegExp(signature.slice(2, 40)));
  const again = await f.app.inject({
    method: 'POST',
    url: revokeUrl,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'already_revoked');
});

test('revoke: a stop between linking and sending resumes the SAME signed operation', async (t) => {
  for (const when of ['before-store', 'after-store'] as const) {
    const f = await setup(t);
    const { created } = await storedLimit(f);
    const revokeUrl = `${limitsUrl()}/${created.permissionId}/revoke`;
    const post = (url: string, payload: unknown = {}) =>
      f.app.inject({
        method: 'POST',
        url,
        headers: as('person-1'),
        payload: JSON.stringify(payload),
      });
    const key = `base-wallet:limit-revoke:${created.permissionId}:1`;
    const request = (await post(revokeUrl)).json();
    const signature = await f.owner.sign({ hash: request.userOpHash });
    // The process stops inside the send: before, or after, the chain module stored it.
    f.ops.crash = when;
    const stopped = await post(`${revokeUrl}/signature`, { signature });
    assert.equal(stopped.statusCode, 503, `${when}: ${stopped.body}`);
    // Linked before anything was sent: the key and the signature are on the row already.
    const row = (
      await f.pg.query<{
        revoke_op_key: string | null;
        revoke_attempt: number;
        signed: boolean;
      }>(
        'SELECT revoke_op_key, revoke_attempt, revoke_signature IS NOT NULL AS signed FROM base_spend_permissions',
      )
    ).rows[0];
    assert.deepEqual(row, { revoke_op_key: key, revoke_attempt: 1, signed: true }, when);

    // Long after the unsigned window: a read resumes it. It never expires and is never prepared
    // again, and no new signature is asked for.
    f.clock.now += 11 * 60_000;
    const view = (await list(f)).json();
    assert.equal(view.limits[0].state, 'revoke_pending', when);
    assert.equal(view.limits[0].revoke.state, 'submitted', when);
    assert.equal(f.ops.prepared.length, 1, when);
    assert.deepEqual(
      [...new Set(f.ops.submitted.map((input) => input.idempotencyKey))],
      [key],
      when,
    );
    for (const input of f.ops.submitted) {
      assert.equal(input.signature, signature, when);
      assert.equal(input.userOpHash, request.userOpHash, when);
    }
    // Before the store it is sent again by the read; after it, the stored one is only followed.
    assert.equal(f.ops.submitted.length, when === 'before-store' ? 2 : 1, when);
    assert.equal(f.ops.stored.size, 1, when);
    const busy = await post(revokeUrl);
    assert.equal(busy.statusCode, 409, when);
    assert.equal(busy.json().code, 'revoke_in_progress', when);
    assert.equal(f.ops.prepared.length, 1, when);
    const kinds = (
      await f.pg.query<{ kind: string }>('SELECT kind FROM base_audit_events ORDER BY event_id')
    ).rows.map((event) => event.kind);
    assert.equal(kinds.filter((kind) => kind === 'limit_revoke_signed').length, 1, when);
    assert.equal(kinds.filter((kind) => kind === 'limit_revoke_submitted').length, 1, when);
  }
});

test('revoke: an unsigned operation expires; a failed or outdated one is prepared again', async (t) => {
  const f = await setup(t);
  const { created } = await storedLimit(f);
  const revokeUrl = `${limitsUrl()}/${created.permissionId}/revoke`;
  const post = (url: string, payload: unknown = {}) =>
    f.app.inject({
      method: 'POST',
      url,
      headers: as('person-1'),
      payload: JSON.stringify(payload),
    });

  // Base is unreachable: the agent is blocked anyway, the owner can try again.
  f.ops.fail = new OwnerRevokeError('FEE_CAP', 'fees');
  const capped = await post(revokeUrl);
  assert.equal(capped.statusCode, 503);
  assert.equal(capped.json().code, 'fee_cap');
  const blocked = await f.pg.query<{ state: string }>('SELECT state FROM base_spend_permissions');
  assert.equal(blocked.rows[0].state, 'revoke_pending');
  f.ops.fail = null;

  const first = (await post(revokeUrl)).json();
  f.clock.now += 11 * 60_000;
  const late = await post(`${revokeUrl}/signature`, {
    signature: await f.owner.sign({ hash: first.userOpHash }),
  });
  assert.equal(late.statusCode, 410);
  assert.equal(late.json().code, 'expired');
  assert.equal((await list(f)).json().limits[0].revoke.state, 'expired');

  // A fresh one after expiry; the wallet moved on before it was sent: prepare again.
  const second = (await post(revokeUrl)).json();
  assert.notEqual(second.userOpHash, first.userOpHash);
  f.ops.fail = new OwnerRevokeError('OUTDATED', 'moved');
  const outdated = await post(`${revokeUrl}/signature`, {
    signature: await f.owner.sign({ hash: second.userOpHash }),
  });
  assert.equal(outdated.statusCode, 409);
  assert.equal(outdated.json().code, 'operation_outdated');
  f.ops.fail = null;

  const third = (await post(revokeUrl)).json();
  assert.notEqual(third.userOpHash, second.userOpHash);
  const sent = await post(`${revokeUrl}/signature`, {
    signature: await f.owner.sign({ hash: third.userOpHash }),
  });
  assert.equal(sent.statusCode, 202, sent.body);
  assert.equal(
    f.ops.submitted.at(-1)!.idempotencyKey,
    `base-wallet:limit-revoke:${created.permissionId}:3`,
  );
  // Its nonce was used by another owner operation: failed, so a new attempt is allowed.
  f.ops.status = 'failed';
  const retry = await post(revokeUrl);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().revokeState, 'awaiting_signature');
  // Nothing to sign for a limit that was never revoked; a body is refused.
  assert.equal((await post(revokeUrl, { force: true })).statusCode, 400);
});

test('the view: Base at one block, the Berlin counter, honest when Base cannot be read', async (t) => {
  const f = await setup(t);
  const empty = await list(f);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().limits, []);
  assert.equal(empty.json().stale, false);

  const { created } = await storedLimit(f);
  // Before the first Berlin midnight Base allows nothing yet: no current period, never zeros
  // invented for one.
  let view = (await list(f)).json();
  let limit = view.limits[0];
  assert.equal(view.stale, false);
  assert.equal(view.readAtBlock, 1000);
  assert.equal(limit.onchain.phase, 'before_start');
  assert.equal(limit.onchain.start, MIDNIGHT);
  assert.equal(limit.onchain.end, LIMIT_PERMISSION_END);
  assert.equal(limit.onchain.currentPeriodStart, null);
  assert.equal(limit.onchain.leftRaw, '0');
  assert.equal(limit.calendar.timeZone, 'Europe/Berlin');
  assert.equal(limit.calendar.periodStart, Date.UTC(2026, 9, 9, 22) / 1000);
  assert.equal(limit.calendar.periodEnd, MIDNIGHT);

  // Monday afternoon: approved, 4 USDC spent in the current Base day, 6 USDC in the Berlin day.
  f.clock.now = Date.UTC(2026, 9, 12, 13);
  f.chain.time = f.clock.now / 1000;
  f.chain.approved.add(created.permissionHash);
  f.chain.spend.set(created.permissionHash, 4_000_000n);
  await f.pg.query(`UPDATE base_spend_permissions SET state = 'onchain'`);
  for (const [ref, amount, at, state] of [
    ['p-1', 4_000_000, Date.UTC(2026, 9, 12, 9), 'consumed'],
    ['p-2', 2_000_000, Date.UTC(2026, 9, 12, 12), 'held'],
    ['p-3', 5_000_000, Date.UTC(2026, 9, 12, 12, 30), 'released'],
    ['p-4', 9_000_000, Date.UTC(2026, 9, 11, 21), 'consumed'],
  ] as const)
    await f.pg.query(
      `INSERT INTO base_wallet_reservations (reservation_id, wallet_id, chain_id, token, amount,
         holder_kind, holder_ref, intent_hash, state, created_at, updated_at)
       VALUES ($1,'w-1',${CHAIN_ID},$2,$3,'payment',$1,'0x00',$4,$5,$5)`,
      [ref, USDC.toLowerCase(), amount, state, at],
    );
  view = (await list(f)).json();
  limit = view.limits[0];
  assert.equal(limit.state, 'approved');
  assert.equal(limit.onchain.phase, 'active');
  assert.equal(limit.onchain.approved, true);
  assert.equal(limit.onchain.currentPeriodStart, Date.UTC(2026, 9, 11, 22) / 1000);
  assert.equal(limit.onchain.currentPeriodEnd, Date.UTC(2026, 9, 12, 22) / 1000);
  assert.equal(limit.onchain.spentRaw, '4000000');
  assert.equal(limit.onchain.leftRaw, '6000000');
  assert.equal(limit.onchain.readAtBlock, 1000);
  // The Berlin day: held + consumed since Monday 00:00, the released one and Sunday's not counted.
  assert.equal(limit.calendar.spentRaw, '6000000');
  assert.equal(limit.calendar.leftRaw, '14000000');

  // Base cannot be read: no on-chain numbers at all, flagged stale; the counter still shows.
  f.chain.fail = true;
  view = (await list(f)).json();
  assert.equal(view.stale, true);
  assert.equal(view.readAtBlock, null);
  assert.equal(view.limits[0].onchain, null);
  assert.equal(view.limits[0].calendar.spentRaw, '6000000');
  // No reader configured at all is the same honest answer.
  const bare = await setup(t, { noReader: true });
  await storedLimit(bare);
  const bareView = (await list(bare)).json();
  assert.equal(bareView.stale, true);
  assert.equal(bareView.limits[0].onchain, null);
});

test('only the wallet owner: other people, outside-owned wallets and signed-out callers', async (t) => {
  const f = await setup(t, { backup: true });
  const { created } = await storedLimit(f);
  // Another person, even one co-owning the agent's workspace, sees nothing.
  for (const [person, agent, workspace] of [
    ['person-2', AGENT, undefined],
    ['person-2', AI_AGENT, 'ai-1'],
    ['person-1', OUTSIDE_AGENT, undefined],
  ] as const) {
    const res = await f.app.inject({ url: limitsUrl(agent), headers: as(person, workspace) });
    assert.equal(res.statusCode, 404, `${person} ${agent}`);
    const prep = await prepare(f, undefined, person, agent);
    assert.equal(prep.statusCode, 404);
  }
  const theirs = await f.app.inject({
    method: 'POST',
    url: `${limitsUrl()}/${created.permissionId}/revoke`,
    headers: as('person-2'),
    payload: '{}',
  });
  assert.equal(theirs.statusCode, 404);
  // The owner reaches the wallet of a co-owned workspace's agent with any workspace selected.
  const own = await f.app.inject({ url: limitsUrl(AI_AGENT), headers: as('person-1', 'ai-1') });
  assert.equal(own.statusCode, 200, own.body);
  // Signed out: 401; an AI workspace key is not a person: 404.
  assert.equal((await f.app.inject({ url: limitsUrl() })).statusCode, 401);
  const aiKey = await f.app.inject({ url: limitsUrl(), headers: as('ai-1') });
  assert.equal(aiKey.statusCode, 404);
  // A limit id of another wallet is not found.
  const other = await f.app.inject({
    method: 'POST',
    url: `${limitsUrl(AI_AGENT)}/${created.permissionId}/revoke`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(other.statusCode, 404);
});

test('a new limit needs the backup key confirmed', async (t) => {
  const f = await setup(t, { backup: false });
  const res = await prepare(f);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'backup_required');
  for (const body of [{ capRaw: '0', period: 'day' }, { capRaw: '10', period: 'hour' }, {}]) {
    const bad = await prepare(f, body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
  }
  // Reading limits needs no backup.
  assert.equal((await list(f)).statusCode, 200);
});

// The browser's checks (src/base/wallet/limits.ts) on what this service really prepares.

test('contract: the browser checks the real revoke operation, signs its raw hash, and the server takes it', async (t) => {
  const f = await setup(t);
  const { created } = await storedLimit(f);
  const view = (await list(f)).json();
  const limit = view.limits[0];
  const revokeUrl = `${limitsUrl()}/${created.permissionId}/revoke`;
  const res = await f.app.inject({
    method: 'POST',
    url: revokeUrl,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.equal(res.statusCode, 200, res.body);
  const request = res.json();
  const hash = clientCheckRevoke({
    request,
    wallet: f.wallets[AGENT],
    owner: f.owner.address,
    agentId: AGENT,
    limit,
    sponsors: { [CHAIN_ID]: [getAddress(`0x${'7a'.repeat(20)}`)] },
  });
  assert.equal(hash, request.userOpHash);
  const sent = await f.app.inject({
    method: 'POST',
    url: `${revokeUrl}/signature`,
    headers: as('person-1'),
    payload: JSON.stringify({ signature: await f.owner.sign({ hash }) }),
  });
  assert.equal(sent.statusCode, 202, sent.body);
  assert.equal(sent.json().revoke.state, 'submitted');
});

test('contract: the browser reads the wallet spender, checks the real prepared limit, and the server stores what it signed', async (t) => {
  const f = await setup(t);
  const read = await f.app.inject({
    method: 'POST',
    url: `/api/base/agents/${AGENT}/wallet`,
    headers: as('person-1'),
    payload: '{}',
  });
  assert.ok(read.statusCode === 200 || read.statusCode === 201, read.body);
  const wallet = read.json() as { address: string; spenderAddress?: string };
  assert.equal(wallet.spenderAddress, SPENDER);
  const res = await prepare(f);
  assert.equal(res.statusCode, 200, res.body);
  const prepared = res.json();
  const checked = clientCheckLimit({
    prepared,
    wallet: wallet.address ?? f.wallets[AGENT],
    owner: f.owner.address,
    agentId: AGENT,
    spender: wallet.spenderAddress,
    capRaw: '20000000',
    period: 'day',
    now: f.clock.now,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(checked.typedData)),
    JSON.parse(JSON.stringify(prepared.typedData)),
  );
  const stored = await f.app.inject({
    method: 'POST',
    url: limitsUrl(),
    headers: as('person-1'),
    payload: JSON.stringify({
      permission: prepared.permission,
      capRaw: '20000000',
      period: 'day',
      signature: await f.owner.signTypedData(checked.typedData),
    }),
  });
  assert.equal(stored.statusCode, 201, stored.body);
});
