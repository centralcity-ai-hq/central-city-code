import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  parseAbiItem,
  toHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../server/app.js';
import type { Database } from '../server/database.js';
import {
  agentWalletRecipe,
  deriveAddressLocal,
  spenderAccountRecipe,
} from '../server/base/chain/derive.js';
import { agentPaymentChain, RECOVERY_GRACE_MS } from '../server/base/chain/payment-chain.js';
import { createReservationLedger } from '../server/base/chain/reservations.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import type { Bundler } from '../server/base/chain/submit.js';
import type { PayChainReader } from '../server/base/pay/chain.js';
import type { AgentPayDeps } from '../server/base/payments/agent-pay.js';
import { PAY_RECOVER_PATH } from '../server/base/payments/recover-cron.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { AssistantScope } from '../shared/assistant.js';
import type { Address } from '../shared/base/chains.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { SPONSOR_DATA_BYTES, SPONSOR_PAYMASTERS } from '../shared/base/paymasters.js';
import {
  LIMIT_PERMISSION_END,
  permissionToJson,
  spendPermissionHash,
} from '../shared/base/spend-limits.js';
import type { SpendPermission } from '../shared/base/types.js';
import { WALLET_CHAIN_ID } from '../shared/base/wallet-network.js';
import { OWNER, PASSWORD } from './oauth-helpers.js';
import { WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/*
 * The owner's stops (withdrawing agent-pay consent, starting the
 * limit revoke, revoking the assistant grant) and the operator's kill switch (CITY_BASE_AGENT_PAY
 * off) must stop a payment whose FIRST send the bundler refused. Such an operation never left the
 * server; it is not "broadcast yet" (server/base/payments/agent-pay.ts:22-23) and a withdrawn
 * consent "stops every new spend at its next check" (server/base/wallet/agent-pay-consent.ts:12).
 *
 * The fixture is a trimmed copy of tests/base-agent-pay-tool.test.ts (createApp on in-memory
 * PGlite, the real agent pay service, the real payment chain over a fake Base node, a fake bundler
 * and a throwaway local spender key). Nothing reaches a network. Local data only.
 *
 * A first send that may never have reached the bundler is sent again only past the payment's current
 * authority (submit.ts beforeRebroadcast): city_pay_status checks it, the recovery cron never sends one.
 */

const NETWORK = WALLET_NET;
const CHAIN_ID = WALLET_CHAIN_ID;
const USDC = NETWORK.tokens.USDC.address;
const ENTRY_POINT = NETWORK.contracts.entryPointV06;
const PINNED = (SPONSOR_PAYMASTERS[CHAIN_ID] ?? [])[0]!;
const SETTLE = 3n;
const json = { 'content-type': 'application/json', 'x-city-request': '1' };
const FLAGS = { CITY_BASE_WALLET: '1', CITY_BASE_AGENT_PAY: '1', CITY_BASE_MAINNET: '1' };
// Built at run time: a fixed literal reads as a leaked credential to the secrets scan.
const CRON_SECRET = randomUUID();
const CRON_FLAGS = { ...FLAGS, CRON_SECRET };

const OWNER_A = privateKeyToAccount(generatePrivateKey());
const OWNER_B = privateKeyToAccount(generatePrivateKey());
const SPENDER_KEY = privateKeyToAccount(generatePrivateKey());
const SPENDER = deriveAddressLocal(spenderAccountRecipe(NETWORK, SPENDER_KEY.address));

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

function sponsorData(): Hex {
  return concat([
    PINNED,
    pad('0x', { size: 31 }),
    zeroAddress,
    pad('0x', { size: SPONSOR_DATA_BYTES - 20 - 31 - 20 }),
  ]);
}

function withEnv(
  t: { after: (fn: () => unknown) => void },
  values: Record<string, string | undefined>,
) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  apply(values);
  t.after(() => apply(saved));
}

function fakeBase() {
  const state = {
    head: 1000n,
    owners: new Map<string, Address>(),
    balance: 100_000_000n,
    nonces: new Map<string, bigint>(),
    code: new Set<string>(),
    /** Operations the bundler accepted and holds (not yet landed). */
    pool: new Map<Hex, UserOperation<'0.6'>>(),
    /** Every send attempt that reached the bundler, refused or accepted. */
    sends: [] as Hex[],
    /** The bundler definitively refuses the send (as an HTTP 429 / 5xx would): it keeps nothing. */
    sendRefused: false,
    landed: new Map<Hex, { txHash: Hex; blockNumber: bigint; sender: Address; nonce: bigint }>(),
    signatures: 0,
  };
  const blockHash = (n: bigint) => keccak256(toHex(`fake-block-${n}`));
  const reader: PayChainReader = {
    registry: WALLET_EXPECTED.registry,
    chainId: CHAIN_ID,
    async ownerOf(baseId) {
      return {
        block: state.head,
        blockHash: blockHash(state.head),
        owner: state.owners.get(baseId) ?? null,
      };
    },
  };
  const lane = (sender: string, key: bigint) => `${sender.toLowerCase()}:${key}`;
  const client = {
    getCode: async ({ address }: { address: string }) =>
      state.code.has(address.toLowerCase()) ? '0x6080' : undefined,
    readContract: async (call: { functionName: string; args: [string, bigint] }) => {
      if (call.functionName === 'getNonce') {
        const [sender, key] = call.args;
        return (key << 64n) | (state.nonces.get(lane(sender, key)) ?? 0n);
      }
      if (call.functionName === 'isApproved') return true;
      if (call.functionName === 'getCurrentPeriod') return { start: 0, end: 0, spend: 0n };
      throw new Error(`no ${call.functionName} on the fake node`);
    },
    getBlockNumber: async () => state.head,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string } = {}) => {
      const number =
        args.blockNumber ??
        (args.blockTag === 'finalized' || args.blockTag === 'safe'
          ? state.head - SETTLE
          : state.head);
      return { number, hash: blockHash(number) };
    },
    getLogs: async (query: { args: { userOpHash: Hex }; fromBlock: bigint; toBlock: bigint }) => {
      const hit = state.landed.get(query.args.userOpHash);
      if (!hit || hit.blockNumber < query.fromBlock || hit.blockNumber > query.toBlock) return [];
      return [
        {
          args: {
            userOpHash: query.args.userOpHash,
            sender: hit.sender,
            paymaster: PINNED,
            nonce: hit.nonce,
            success: true,
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
              args: { userOpHash, sender: hit.sender, paymaster: PINNED },
            }),
            data: encodeAbiParameters(
              [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
              [hit.nonce, true, 1_000n, 100n],
            ),
          },
        ],
      };
    },
  } as unknown as PublicClient;
  const bundler: Bundler = {
    async prepare(op) {
      return {
        ...op,
        callGasLimit: 100_000n,
        verificationGasLimit: 100_000n,
        preVerificationGas: 50_000n,
        maxFeePerGas: 1_000_000n,
        maxPriorityFeePerGas: 1_000n,
        paymasterAndData: sponsorData(),
      };
    },
    async send(op) {
      const hash = getUserOperationHash({
        chainId: CHAIN_ID,
        entryPointAddress: ENTRY_POINT,
        entryPointVersion: '0.6',
        userOperation: op,
      });
      state.sends.push(hash);
      // A definite refusal: the bundler did not take the operation and keeps nothing of it.
      if (state.sendRefused) throw new Error('HTTP 429 Too Many Requests: operation not accepted');
      if (!state.landed.has(hash)) state.pool.set(hash, op);
      return hash;
    },
    async receipt(userOpHash) {
      const hit = state.landed.get(userOpHash);
      return hit
        ? {
            success: true,
            txHash: hit.txHash,
            blockNumber: hit.blockNumber,
            actualGasUsed: 100n,
            actualGasCost: 1_000n,
          }
        : null;
    },
  };
  const keystore = {
    async withSigner<T>(
      _ref: string,
      use: (account: typeof SPENDER_KEY) => Promise<T>,
    ): Promise<T> {
      state.signatures++;
      return use(SPENDER_KEY);
    },
  };
  /** An operation the bundler holds lands in the next block and becomes final at once. */
  function land(userOpHash: Hex) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the bundler holds the operation');
    state.head += 1n;
    const key = op.nonce >> 64n;
    state.nonces.set(lane(op.sender, key), (op.nonce & (2n ** 64n - 1n)) + 1n);
    state.code.add(op.sender.toLowerCase());
    state.landed.set(userOpHash, {
      txHash: keccak256(concat([userOpHash, '0x01'])),
      blockNumber: state.head,
      sender: getAddress(op.sender),
      nonce: op.nonce,
    });
    state.pool.delete(userOpHash);
    state.head += SETTLE;
  }
  return { state, reader, client, bundler, keystore, land };
}

type Base = ReturnType<typeof fakeBase>;

function chainOf(base: Base, db: () => Database): AgentPayDeps['chain'] {
  return async (authorize) =>
    agentPaymentChain({
      network: NETWORK,
      client: base.client,
      db: db(),
      operations: pgChainOperationStore(db()),
      bundler: base.bundler,
      keystore: base.keystore,
      signerOf: async () => SPENDER_KEY.address,
      ledger: createReservationLedger({
        chainId: CHAIN_ID,
        balanceOf: async () => ({ balance: base.state.balance, blockNumber: base.state.head }),
      }),
      maxCostWeiCap: 10n ** 15n,
      authorize: async (intent, limit) => authorize(intent, limit),
    });
}

let address = 10;

async function setup(t: { after: (fn: () => unknown) => void }, env = FLAGS) {
  withEnv(t, env);
  const base = fakeBase();
  let database: Database | undefined;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    agentPay: { chain: chainOf(base, () => database!), recipients: base.reader },
  });
  t.after(() => app.close());
  const db = app.city.db;
  database = db;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    db.query<T>(text, params).then((res) => res.rows);

  const register = async (name: string, password: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: json,
      payload: JSON.stringify({ name, password }),
      remoteAddress: `198.51.100.${address++}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    const session = res.cookies.find((entry) => entry.name === 'cc_session')!.value;
    return { id: res.json().operator.id as string, cookie: `cc_session=${session}` };
  };
  const payer = await register(OWNER, PASSWORD);
  const payee = await register('Payee owner', 'payee owner password 0001');

  const grant = async (scopes: AssistantScope[]) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant-access',
      headers: { ...json, cookie: payer.cookie },
      payload: JSON.stringify({ label: 'Pay client', scopes, expiresInDays: 1 }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { grant: { id: string }; token: string };
  };
  const call = (token: string, name: string, args: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...json, authorization: `Bearer ${token}` },
      payload: JSON.stringify(args),
    });

  const main = await grant(['workspace:read', 'agents:create', 'pay']);
  const created = await call(main.token, 'city_create_agent', {
    name: 'Harbor',
    description: 'Research agent',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const agentA = created.json().agent.id as string;

  for (const [account, owner] of [
    [payer.id, OWNER_A.address],
    [payee.id, OWNER_B.address],
  ] as const)
    await sql(
      `INSERT INTO base_owner_vaults (operator_id, owner_address, encrypted_owner_key, kdf_params,
         cipher_params, version, backup_confirmed_at, created_at, updated_at)
       VALUES ($1, $2, decode($3, 'hex'), '{}', '{}', 1, 1, 1, 1)`,
      [account, owner, '5a'.repeat(48)],
    );

  const addWallet = async (w: {
    agentId: string;
    workspace: string;
    account: string | null;
    owner: Address;
    spender: Address;
  }) => {
    const recipe = agentWalletRecipe(NETWORK, w.owner, accountIndexFor(w.agentId));
    const wallet = deriveAddressLocal(recipe);
    await sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000001', $8,
         'derived', 1, 1, $9)`,
      [
        `wallet-${w.agentId}`,
        w.agentId,
        w.workspace,
        CHAIN_ID,
        wallet,
        w.owner,
        w.spender,
        JSON.stringify({
          version: 1,
          owners: recipe.owners,
          factory: recipe.factory,
          implementationVersion: 'test-impl-0001',
          accountIndex: recipe.index.toString(10),
        }),
        w.account,
      ],
    );
    return wallet;
  };

  // The payee's agent Juno: Base ID 501, passport CC-Juno01, a ready vault wallet.
  const agentR = randomUUID();
  const walletR = await addWallet({
    agentId: agentR,
    workspace: payee.id,
    account: payee.id,
    owner: OWNER_B.address,
    spender: getAddress(`0x${'4d'.repeat(20)}`),
  });
  await sql('INSERT INTO base_short_ids VALUES ($1, $2, 1)', ['Juno01', agentR]);
  await sql(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
       transfer_op_id, handover_id, handover_finality, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, 1, $9, $9, $10, 1, 'final', $8, $10,
       'final', 1)`,
    [
      agentR,
      CHAIN_ID,
      payee.id,
      WALLET_EXPECTED.registry,
      '501',
      `${AGENT_URI_ORIGIN}/a/Juno01`,
      walletR,
      `identity:transfer:${CHAIN_ID}:${agentR}~501`,
      `identity:register:${CHAIN_ID}:${agentR}`,
      '501',
    ],
  );
  base.state.owners.set('501', getAddress(walletR));

  /** Agent A's wallet, the owner's signed USDC limit and the owner's consent for it. */
  const ready = async () => {
    const walletA = await addWallet({
      agentId: agentA,
      workspace: payer.id,
      account: payer.id,
      owner: OWNER_A.address,
      spender: SPENDER,
    });
    const allowance = 10_000_000n;
    const permission: SpendPermission = {
      account: getAddress(walletA),
      spender: SPENDER,
      token: getAddress(USDC),
      allowance,
      period: 86_400,
      start: Math.floor(Date.now() / 1000) - 86_400,
      end: LIMIT_PERMISSION_END,
      salt: 1n,
      extraData: '0x',
    };
    const permissionId = randomUUID();
    const hash = spendPermissionHash(CHAIN_ID, permission).toLowerCase();
    await sql(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
         signature, state, token, permission_hash, period_kind, cap_raw, onchain_model,
         owner_account_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'signed', $6, $7, 'day', $8, 'full', $9, $10, $10)`,
      [
        permissionId,
        `wallet-${agentA}`,
        CHAIN_ID,
        JSON.stringify(permissionToJson(permission)),
        Buffer.from('ab'.repeat(65), 'hex'),
        USDC.toLowerCase(),
        hash,
        allowance.toString(10),
        payer.id,
        Date.now(),
      ],
    );
    const given = await app.inject({
      method: 'PUT',
      url: `/api/base/agents/${agentA}/wallet/agent-pay`,
      headers: { ...json, cookie: payer.cookie },
      payload: JSON.stringify({ permissionHash: hash }),
    });
    assert.equal(given.statusCode, 200, given.body);
    assert.equal(given.json().mayPay, true);
    return { walletA, permissionId };
  };

  /** The owner's documented stop: DELETE /wallet/agent-pay (withdraw consent). */
  const withdraw = () =>
    app.inject({
      method: 'DELETE',
      url: `/api/base/agents/${agentA}/wallet/agent-pay`,
      headers: { ...json, cookie: payer.cookie },
      payload: '{}',
    });
  /** The owner revokes an assistant grant. */
  const revokeGrant = (id: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/assistant-access/${id}`,
      headers: { ...json, cookie: payer.cookie },
      payload: '{}',
    });
  /** Phase 1 of the owner's limit revoke, as limits.ts:851 writes it: the DB blocks the agent. */
  const startLimitRevoke = (permissionId: string) =>
    sql(
      `UPDATE base_spend_permissions SET state = 'revoke_pending', revoke_requested_at = $2,
         updated_at = $2 WHERE permission_id = $1 AND state IN ('signed','onchain')`,
      [permissionId, Date.now()],
    );

  const pay = (args: Record<string, unknown> = {}, token = main.token) =>
    call(token, 'city_pay', {
      from_agent_id: agentA,
      recipient: 'centralcity.ai/a/Juno01',
      amount: '2.5',
      idempotency_key: randomUUID(),
      ...args,
    });
  const status = (paymentId: string, token = main.token) =>
    call(token, 'city_pay_status', { payment_id: paymentId });
  const recoverCron = () =>
    app.inject({ url: PAY_RECOVER_PATH, headers: { authorization: `Bearer ${CRON_SECRET}` } });
  /** Moves every reservation's creation back past the grace period. */
  const age = () =>
    sql('UPDATE base_wallet_reservations SET created_at = created_at - $1', [
      RECOVERY_GRACE_MS + 1,
    ]);

  return {
    app,
    sql,
    base,
    grant,
    main,
    agentA,
    ready,
    withdraw,
    revokeGrant,
    startLimitRevoke,
    pay,
    status,
    recoverCron,
    age,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Where the money stands: the payment row, its reservation and its chain operation. */
async function outcome(f: Fixture) {
  const [payment] = await f.sql<{ state: string }>('SELECT state FROM base_payments');
  const [reservation] = await f.sql<{ state: string }>(
    'SELECT state FROM base_wallet_reservations',
  );
  const [op] = await f.sql<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM base_chain_ops',
  );
  return {
    payment: payment?.state,
    reservation: reservation?.state,
    op: op?.status,
    opError: op?.error_code ?? null,
  };
}

/**
 * The bundler refuses the first send; city_pay answers 'pending' and the stored operation is
 * 'unknown'/BROADCAST_AMBIGUOUS. Nothing is in the bundler's pool: no money can move yet.
 */
async function refusedFirstSend(f: Fixture) {
  const ready = await f.ready();
  f.base.state.sendRefused = true;
  const res = await f.pay();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'pending');
  assert.equal(f.base.state.sends.length, 1, 'one send attempt, refused');
  assert.equal(f.base.state.pool.size, 0, 'the bundler holds nothing');
  const before = await outcome(f);
  assert.equal(before.op, 'unknown');
  assert.equal(before.opError, 'BROADCAST_AMBIGUOUS');
  assert.equal(before.reservation, 'held');
  f.base.state.sendRefused = false;
  return { ...ready, paymentId: res.json().payment_id as string, hash: f.base.state.sends[0]! };
}

/**
 * If the server re-sent after the stop, let the bundler's copy land and reconcile once more, so the
 * consequence (USDC moved, reservation consumed, payment paid) is part of the evidence.
 */
async function landIfResent(f: Fixture, hash: Hex, reconcile: () => Promise<unknown>) {
  if (!f.base.state.pool.has(hash)) return false;
  f.base.land(hash);
  await reconcile();
  return true;
}

test('status path: after the owner withdraws consent, city_pay_status never re-sends a payment whose first send was refused', async (t) => {
  const f = await setup(t);
  const { paymentId, hash } = await refusedFirstSend(f);

  // The owner sees an unexpected pending payment and uses the documented stop.
  const off = await f.withdraw();
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().mayPay, false);
  const sendsAtStop = f.base.state.sends.length;

  // The (possibly prompt-injected) assistant still holds a valid pay grant and polls the status.
  const read = await f.status(paymentId);
  assert.equal(read.statusCode, 200, read.body);
  const resentAfterStop = f.base.state.sends.slice(sendsAtStop);
  const landed = await landIfResent(f, hash, () => f.status(paymentId));
  const after = await outcome(f);
  const evidence = JSON.stringify({ resentAfterStop, landed, after });

  assert.deepEqual(
    resentAfterStop,
    [],
    `no broadcast after consent was withdrawn (observed: ${evidence})`,
  );
  assert.notEqual(after.reservation, 'consumed', `no USDC spent after the stop: ${evidence}`);
  assert.notEqual(after.payment, 'paid', `the payment is not paid after the stop: ${evidence}`);
});

test('status path: after the owner starts the limit revoke (revoke_pending), city_pay_status never re-sends', async (t) => {
  const f = await setup(t);
  const { paymentId, hash, permissionId } = await refusedFirstSend(f);

  await f.startLimitRevoke(permissionId);
  const [limit] = await f.sql<{ state: string }>(
    'SELECT state FROM base_spend_permissions WHERE permission_id = $1',
    [permissionId],
  );
  assert.equal(limit!.state, 'revoke_pending');
  // A new payment is refused at once: the DB stop works for new payments.
  const fresh = await f.pay();
  assert.notEqual(fresh.statusCode, 200, fresh.body);
  const sendsAtStop = f.base.state.sends.length;

  const read = await f.status(paymentId);
  assert.equal(read.statusCode, 200, read.body);
  const resentAfterStop = f.base.state.sends.slice(sendsAtStop);
  const landed = await landIfResent(f, hash, () => f.status(paymentId));
  const after = await outcome(f);
  const evidence = JSON.stringify({ resentAfterStop, landed, after });

  assert.deepEqual(
    resentAfterStop,
    [],
    `no broadcast after the limit revoke started (observed: ${evidence})`,
  );
  assert.notEqual(after.reservation, 'consumed', `no USDC spent after the stop: ${evidence}`);
  assert.notEqual(after.payment, 'paid', `the payment is not paid after the stop: ${evidence}`);
});

test('cron path: consent withdrawn, grant revoked, limit revoke started and agent pay switched off: the recovery cron never re-sends', async (t) => {
  const f = await setup(t, CRON_FLAGS);
  const { hash, permissionId } = await refusedFirstSend(f);

  // Every DB-level stop the owner and the operator have.
  const off = await f.withdraw();
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().mayPay, false);
  const revoked = await f.revokeGrant(f.main.grant.id);
  assert.equal(revoked.statusCode, 200, revoked.body);
  await f.startLimitRevoke(permissionId);
  delete process.env.CITY_BASE_AGENT_PAY; // the kill switch (restored by withEnv after the test)
  const sendsAtStop = f.base.state.sends.length;

  // The recovery cron's grace period passes (10 minutes) and it runs.
  await f.age();
  const run = await f.recoverCron();
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().checked, 1, run.body);
  const resentAfterStop = f.base.state.sends.slice(sendsAtStop);
  const landed = await landIfResent(f, hash, () => f.recoverCron());
  const after = await outcome(f);
  const evidence = JSON.stringify({ resentAfterStop, landed, after, firstRun: run.json() });

  assert.deepEqual(
    resentAfterStop,
    [],
    `no broadcast after every stop was applied (observed: ${evidence})`,
  );
  assert.notEqual(after.reservation, 'consumed', `no USDC spent after the stops: ${evidence}`);
  assert.notEqual(after.op, 'final', `the operation never lands after the stops: ${evidence}`);
});
