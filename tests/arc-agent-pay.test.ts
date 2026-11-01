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
import { intentFor } from '../server/base/payments/service.js';
import { arcScreening } from '../server/base/wallet/routes.js';
import { accountIndexFor } from '../server/base/wallet/service.js';
import type { Database } from '../server/database.js';
import type { ScreeningRequest } from '../server/protocol/screening/gate.js';
import { readPaymentReceipt } from '../server/base/chain/payment-receipt.js';
import { createPaymentIntentStore } from '../server/base/payments/store.js';
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
import { ARC_MAINNET, chainNetwork, type ChainNetwork } from '../shared/chains.js';
import { OWNER, PASSWORD } from './oauth-helpers.js';
import { WALLET_NET } from './wallet-network-fixture.js';

/*
 * city_pay on the agent's own chain: an Arc agent pays an Arc agent, end to end in the app (createApp
 * on PGlite), over the real assistant checks, payment service, store, authority and payment chain
 * with the pinned sponsor rule. Both chains are fake nodes, the bundlers fakes, the keys throwaway:
 * nothing reaches a network. Synthetic data only.
 */

const CRON = 'synthetic-cron-secret';
const FLAGS = {
  CITY_BASE_WALLET: '1',
  CITY_BASE_AGENT_PAY: '1',
  CITY_BASE_MAINNET: '1',
  CITY_ARC: '1',
  CITY_ARC_CHAIN_ID: String(ARC_MAINNET),
  CRON_SECRET: CRON,
};
const json = { 'content-type': 'application/json', 'x-city-request': '1' };
const ARC_NET = chainNetwork(ARC_MAINNET, { CITY_ARC: '1' })!;
const SETTLE = 3n;
const OWNER_A = privateKeyToAccount(generatePrivateKey());
const OWNER_B = privateKeyToAccount(generatePrivateKey());
const SPENDER_KEY = privateKeyToAccount(generatePrivateKey());
const FOREIGN = getAddress(`0x${'3e'.repeat(20)}`);

const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

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

/** One chain as the payment chain and the recipient check see it, with a bundler and a keystore. */
function fakeChain(network: ChainNetwork) {
  const pinned = SPONSOR_PAYMASTERS[network.chainId]![0]!;
  const entryPoint = network.contracts.entryPointV06;
  const state = {
    head: 1000n,
    owners: new Map<string, Address>(),
    paymaster: 'pinned' as 'pinned' | 'foreign',
    balance: 100_000_000n,
    nonces: new Map<string, bigint>(),
    code: new Set<string>(),
    pool: new Map<Hex, UserOperation<'0.6'>>(),
    sends: [] as Hex[],
    landed: new Map<Hex, { txHash: Hex; blockNumber: bigint; sender: Address; nonce: bigint }>(),
    signatures: 0,
    chains: 0,
  };
  const blockHash = (n: bigint) => keccak256(toHex(`fake-block-${network.chainId}-${n}`));
  const reader: PayChainReader = {
    registry: network.contracts.identityRegistry as Address,
    chainId: network.chainId,
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
            paymaster: pinned,
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
            address: entryPoint,
            topics: encodeEventTopics({
              abi: [userOperationEvent],
              eventName: 'UserOperationEvent',
              args: { userOpHash, sender: hit.sender, paymaster: pinned },
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
        paymasterAndData: concat([
          state.paymaster === 'foreign' ? FOREIGN : pinned,
          pad('0x', { size: 31 }),
          zeroAddress,
          pad('0x', { size: SPONSOR_DATA_BYTES - 20 - 31 - 20 }),
        ]),
      };
    },
    async send(op) {
      const hash = getUserOperationHash({
        chainId: network.chainId,
        entryPointAddress: entryPoint,
        entryPointVersion: '0.6',
        userOperation: op,
      });
      state.sends.push(hash);
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
  function land(userOpHash: Hex) {
    const op = state.pool.get(userOpHash);
    assert.ok(op, 'the operation was sent');
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
  const chain =
    (db: () => Database): AgentPayDeps['chain'] =>
    async (authorize) => {
      state.chains++;
      return agentPaymentChain({
        network: network as never,
        client,
        db: db(),
        operations: pgChainOperationStore(db()),
        bundler,
        keystore,
        signerOf: async () => SPENDER_KEY.address,
        ledger: createReservationLedger({
          chainId: network.chainId,
          balanceOf: async () => ({ balance: state.balance, blockNumber: state.head }),
        }),
        maxCostWeiCap: 10n ** 15n,
        authorize,
      });
    };
  return { state, reader, land, chain, network };
}

type Screen = (request: ScreeningRequest) => Promise<{ allowed: boolean; outcome: string }>;
const clear: Screen = async () => ({ allowed: true, outcome: 'allowed' });
let address = 40;

async function setup(
  t: { after: (fn: () => unknown) => void },
  options: {
    noArcSide?: boolean;
    /** The app's own Arc side and runtime, with none of them configured here. */
    live?: boolean;
    screen?: Screen;
    env?: Record<string, string | undefined>;
  } = {},
) {
  withEnv(t, options.env ?? FLAGS);
  const base = fakeChain(WALLET_NET as unknown as ChainNetwork);
  const arc = fakeChain(ARC_NET);
  const screens: ScreeningRequest[] = [];
  const control = { screen: options.screen ?? clear };
  let database: Database | undefined;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    ...(options.live
      ? {}
      : {
          agentPay: {
            chain: base.chain(() => database!),
            recipients: base.reader,
            ...(options.noArcSide
              ? {}
              : {
                  arcSide: (chainId: number) =>
                    chainId === ARC_MAINNET
                      ? {
                          network: ARC_NET,
                          chain: arc.chain(() => database!),
                          recipients: arc.reader,
                          screen: async (request: ScreeningRequest) => {
                            screens.push(request);
                            return control.screen(request);
                          },
                        }
                      : null,
                }),
          },
        }),
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
  const payee = await register('Payee owner', 'Synthetic payee owner password');
  const grantRes = await app.inject({
    method: 'POST',
    url: '/api/assistant-access',
    headers: { ...json, cookie: payer.cookie },
    payload: JSON.stringify({
      label: 'Synthetic client',
      scopes: ['workspace:read', 'agents:create', 'pay'],
      expiresInDays: 1,
    }),
  });
  assert.equal(grantRes.statusCode, 201, grantRes.body);
  const token = grantRes.json().token as string;
  const call = (name: string, args: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/assistant/tools/${name}`,
      headers: { ...json, authorization: `Bearer ${token}` },
      payload: JSON.stringify(args),
    });
  const createAgent = async (name: string) => {
    const res = await call('city_create_agent', {
      name,
      description: 'Synthetic agent',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().agent.id as string;
  };
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

  /** A vault wallet on one chain. */
  const addWallet = async (w: {
    on: ReturnType<typeof fakeChain>;
    agentId: string;
    workspace: string;
    owner: Address;
    spender: Address;
  }) => {
    const recipe = agentWalletRecipe(w.on.network as never, w.owner, accountIndexFor(w.agentId));
    const wallet = deriveAddressLocal(recipe);
    await sql(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1:00000000-0000-4000-8000-000000000001', $8,
         'derived', 1, 1, $3)`,
      [
        `wallet-${w.agentId}-${w.on.network.chainId}`,
        w.agentId,
        w.workspace,
        w.on.network.chainId,
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
      ],
    );
    return wallet;
  };
  const registerOn = async (r: {
    on: ReturnType<typeof fakeChain>;
    agentId: string;
    workspace: string;
    baseId: string;
    short: string;
    wallet: Address;
  }) => {
    const chainId = r.on.network.chainId;
    await sql('INSERT INTO base_short_ids VALUES ($1, $2, 1)', [r.short, r.agentId]);
    await sql(
      `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
         erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
         register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
         transfer_op_id, handover_id, handover_finality, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, 1, $9, $9, $10, 1, 'final', $8, $10,
         'final', 1)`,
      [
        r.agentId,
        chainId,
        r.workspace,
        r.on.network.contracts.identityRegistry,
        r.baseId,
        `${AGENT_URI_ORIGIN}/a/${r.short}`,
        r.wallet,
        `identity:transfer:${chainId}:${r.agentId}~${r.baseId}`,
        `identity:register:${chainId}:${r.agentId}`,
        r.baseId,
      ],
    );
    r.on.state.owners.set(r.baseId, getAddress(r.wallet));
  };
  let salt = 1n;
  /** The owner's limit for a wallet (signed, USDC, Berlin day cap = allowance). */
  const limit = async (
    on: ReturnType<typeof fakeChain>,
    walletId: string,
    wallet: Address,
    spender: Address,
    allowance = 10_000_000n,
  ) => {
    const token = getAddress(on.network.tokens.USDC.address);
    const permission: SpendPermission = {
      account: getAddress(wallet),
      spender,
      token,
      allowance,
      period: 86_400,
      start: Math.floor(Date.now() / 1000) - 86_400,
      end: LIMIT_PERMISSION_END,
      salt: salt++,
      extraData: '0x',
    };
    const id = randomUUID();
    const hash = spendPermissionHash(on.network, permission).toLowerCase();
    await sql(
      `INSERT INTO base_spend_permissions (permission_id, wallet_id, chain_id, permission,
         signature, state, token, permission_hash, period_kind, cap_raw, onchain_model,
         owner_account_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'signed', $6, $7, 'day', $8, 'full', $9, $10, $10)`,
      [
        id,
        walletId,
        on.network.chainId,
        JSON.stringify(permissionToJson(permission)),
        Buffer.from('ab'.repeat(65), 'hex'),
        token.toLowerCase(),
        hash,
        allowance.toString(10),
        payer.id,
        Date.now(),
      ],
    );
    return { id, hash };
  };
  /** A live consent for exactly that limit on that chain, as the consent route stores it. */
  const consent = (
    on: ReturnType<typeof fakeChain>,
    walletId: string,
    agentId: string,
    p: { id: string; hash: string },
  ) =>
    sql(
      `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
         permission_id, permission_hash, granted_by, granted_at, before_signing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [
        randomUUID(),
        on.network.chainId,
        walletId,
        agentId,
        on.network.tokens.USDC.address.toLowerCase(),
        p.id,
        p.hash,
        payer.id,
        Date.now(),
      ],
    );

  const spender = (on: ReturnType<typeof fakeChain>) =>
    deriveAddressLocal(spenderAccountRecipe(on.network as never, SPENDER_KEY.address));

  /** A payee agent on a chain, with a confirmed registration and a ready wallet. */
  const payeeOn = async (on: ReturnType<typeof fakeChain>, baseId: string, short: string) => {
    const agentId = randomUUID();
    const wallet = await addWallet({
      on,
      agentId,
      workspace: payee.id,
      owner: OWNER_B.address,
      spender: getAddress(`0x${baseId.padStart(40, '4')}`),
    });
    await registerOn({ on, agentId, workspace: payee.id, baseId, short, wallet });
    return { agentId, wallet };
  };
  /** A paying agent on a chain: wallet; with `ready`, a limit and the owner's consent. */
  const payerOn = async (on: ReturnType<typeof fakeChain>, name: string, ready = true) => {
    const agentId = await createAgent(name);
    const from = spender(on);
    const wallet = await addWallet({
      on,
      agentId,
      workspace: payer.id,
      owner: OWNER_A.address,
      spender: from,
    });
    const walletId = `wallet-${agentId}-${on.network.chainId}`;
    if (ready) await consent(on, walletId, agentId, await limit(on, walletId, wallet, from));
    return { agentId, wallet, walletId, spender: from };
  };
  const pay = (agentId: string, args: Record<string, unknown> = {}) =>
    call('city_pay', {
      from_agent_id: agentId,
      recipient: 'CC-Juno01',
      amount: '2.5',
      idempotency_key: randomUUID(),
      ...args,
    });
  return {
    app,
    db,
    sql,
    base,
    arc,
    screens,
    control,
    payer,
    call,
    pay,
    payerOn,
    payeeOn,
    limit,
    consent,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function nothingSent(f: Fixture) {
  for (const on of [f.arc, f.base]) {
    assert.equal(on.state.signatures, 0, 'nothing signed');
    assert.deepEqual(on.state.sends, [], 'nothing broadcast');
  }
  const held = await f.sql<{ state: string }>('SELECT state FROM base_wallet_reservations');
  for (const row of held) assert.notEqual(row.state, 'held', 'nothing left held');
}

test('an Arc agent pays an Arc agent on Arc: sponsored, screened, final, recorded under Arc', async (t) => {
  const f = await setup(t);
  const a = await f.payerOn(f.arc, 'Harbor');
  const r = await f.payeeOn(f.arc, '501', 'Juno01');
  const res = await f.pay(a.agentId);
  assert.equal(res.statusCode, 200, res.body);
  const paid = res.json();
  assert.equal(paid.state, 'pending');
  assert.deepEqual(paid.amount, { raw: '2500000', display: '2.5', token: 'USDC' });
  assert.deepEqual(paid.from, { agentId: a.agentId, wallet: a.wallet, via: 'spending_limit' });
  assert.equal(paid.onchainSender, a.spender);
  assert.equal(paid.to.agentId, r.agentId);
  assert.equal(paid.to.wallet, r.wallet);

  // One operation on Arc; Base was never asked for a chain.
  assert.equal(f.arc.state.signatures, 1);
  assert.equal(f.arc.state.sends.length, 1);
  assert.equal(f.base.state.chains, 0);
  assert.equal(f.base.state.sends.length, 0);
  const op = f.arc.state.pool.get(f.arc.state.sends[0]!)!;
  assert.equal(getAddress(op.sender), a.spender);
  assert.ok(op.callData.toLowerCase().includes(r.wallet.slice(2).toLowerCase()));

  const [row] = await f.sql<{ chain_id: number; token_address: string; state: string }>(
    'SELECT chain_id, token_address, state FROM base_payments',
  );
  assert.equal(Number(row!.chain_id), ARC_MAINNET);
  assert.equal(row!.token_address, ARC_NET.tokens.USDC.address.toLowerCase());

  // Screened through the gate: all three parties, on Arc's USDC, before reserving and before sending.
  assert.ok(f.screens.length >= 2, 'before reserving and again before the broadcast');
  for (const request of f.screens) {
    assert.equal(request.chainId, ARC_MAINNET);
    assert.equal(request.amountRaw, 2_500_000n);
    assert.deepEqual(
      request.parties.map((party) => [party.role, party.address.toLowerCase()]),
      [
        ['payer', a.wallet.toLowerCase()],
        ['spender', a.spender.toLowerCase()],
        ['payee', r.wallet.toLowerCase()],
      ],
    );
  }
  const audit = await f.sql<{ kind: string; detail: Record<string, unknown> }>(
    "SELECT kind, detail FROM base_audit_events WHERE kind LIKE 'agent_payment_%' ORDER BY event_id",
  );
  assert.deepEqual(
    audit.map((event) => event.kind),
    ['agent_payment_created', 'agent_payment_authorized'],
  );
  assert.equal(audit[0]!.detail.chainId, ARC_MAINNET);

  // city_pay_status finds it on Arc, and only final means paid.
  f.arc.land(f.arc.state.sends[0]!);
  const read = await f.call('city_pay_status', { payment_id: paid.payment_id });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().state, 'final');
  assert.match(read.json().txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(read.json().to.agentId, r.agentId);
  assert.equal(f.base.state.chains, 0);
  const after = await f.sql<{ state: string }>('SELECT state FROM base_payments');
  assert.equal(after[0]!.state, 'paid');
});

test('screening: a listed party is refused before anything is stored', async (t) => {
  const f = await setup(t, { screen: async () => ({ allowed: false, outcome: 'blocked' }) });
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  const res = await f.pay(a.agentId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'screening_blocked');
  assert.deepEqual(await f.sql('SELECT 1 FROM base_payments'), []);
  await nothingSent(f);
});

test('screening fails closed: no answer, or an error, is never clearance', async (t) => {
  const f = await setup(t, { screen: async () => ({ allowed: false, outcome: 'unavailable' }) });
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  const first = await f.pay(a.agentId);
  assert.equal(first.statusCode, 503, first.body);
  assert.equal(first.json().code, 'screening_unavailable');
  f.control.screen = async () => {
    throw new Error('the oracle cannot be read');
  };
  const second = await f.pay(a.agentId);
  assert.equal(second.json().code, 'screening_unavailable', second.body);
  assert.deepEqual(await f.sql('SELECT 1 FROM base_payments'), []);
  await nothingSent(f);
});

test('screening again right before the broadcast: blocked there, nothing is sent', async (t) => {
  const f = await setup(t);
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  let asked = 0;
  // Two clear answers (before reserving, before signing); the one before the broadcast is not.
  f.control.screen = async () =>
    ++asked <= 2 ? { allowed: true, outcome: 'allowed' } : { allowed: false, outcome: 'blocked' };
  const res = await f.pay(a.agentId);
  assert.equal(res.json().code, 'screening_blocked', res.body);
  assert.equal(asked, 3);
  assert.deepEqual(f.arc.state.sends, []);
  const [row] = await f.sql<{ state: string }>('SELECT state FROM base_payments');
  assert.equal(row!.state, 'failed', 'recorded as never sent');
  const held = await f.sql<{ state: string }>('SELECT state FROM base_wallet_reservations');
  for (const hold of held) assert.notEqual(hold.state, 'held');
});

test('no payment crosses chains, in either direction', async (t) => {
  const f = await setup(t);
  const onArc = await f.payerOn(f.arc, 'Harbor');
  const onBase = await f.payerOn(f.base, 'Quay');
  const baseAgent = await f.payeeOn(f.base, '501', 'Juno01');
  const arcAgent = await f.payeeOn(f.arc, '777', 'Arco01');

  // From Arc, a Base agent by passport, Base ID or wallet address: not an agent on this chain.
  for (const recipient of ['CC-Juno01', '501', baseAgent.wallet]) {
    const res = await f.pay(onArc.agentId, { recipient });
    assert.equal(res.json().code, 'recipient_not_found', `${recipient}: ${res.body}`);
    assert.doesNotMatch(res.json().error, /\bBase\b/, res.body);
  }
  // From Base, an Arc agent: the same, as ever.
  for (const recipient of ['CC-Arco01', '777', arcAgent.wallet]) {
    const res = await f.pay(onBase.agentId, { recipient });
    assert.equal(res.json().code, 'recipient_not_found', `${recipient}: ${res.body}`);
  }
  assert.deepEqual(await f.sql('SELECT 1 FROM base_payments'), []);
  await nothingSent(f);
});

test('limits and consent on Arc: none, another chain’s, or over the limit: refused, naming Arc', async (t) => {
  const f = await setup(t);
  await f.payeeOn(f.arc, '501', 'Juno01');
  const bare = await f.payerOn(f.arc, 'Harbor', false);
  const noLimit = await f.pay(bare.agentId);
  assert.equal(noLimit.json().code, 'no_spending_limit', noLimit.body);
  assert.match(noLimit.json().error, /on Arc/);

  const limited = await f.limit(f.arc, bare.walletId, bare.wallet, bare.spender, 1_000_000n);
  const noConsent = await f.pay(bare.agentId);
  assert.equal(noConsent.json().code, 'no_consent', noConsent.body);

  // A consent recorded for Base's chain does not cover Arc's limit.
  await f.sql(
    `INSERT INTO base_agent_pay_consents (consent_id, chain_id, wallet_id, agent_id, token,
       permission_id, permission_hash, granted_by, granted_at, before_signing)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, true)`,
    [
      randomUUID(),
      WALLET_CHAIN_ID,
      bare.walletId,
      bare.agentId,
      ARC_NET.tokens.USDC.address.toLowerCase(),
      limited.id,
      limited.hash,
      f.payer.id,
    ],
  );
  const otherChain = await f.pay(bare.agentId);
  assert.equal(otherChain.json().code, 'no_consent', otherChain.body);
  await nothingSent(f);

  await f.sql('UPDATE base_agent_pay_consents SET chain_id = $1', [ARC_MAINNET]);
  const over = await f.pay(bare.agentId, { amount: '5' });
  assert.equal(over.json().code, 'over_limit', over.body);
  assert.deepEqual(f.arc.state.sends, []);
});

test('idempotency is per chain: a retry is one payment, another intent is refused, Base’s key is Base’s', async (t) => {
  const f = await setup(t);
  const a = await f.payerOn(f.arc, 'Harbor');
  const b = await f.payerOn(f.base, 'Quay');
  await f.payeeOn(f.arc, '501', 'Juno01');
  await f.payeeOn(f.base, '502', 'Bayo01');
  const key = randomUUID();
  const first = await f.pay(a.agentId, { idempotency_key: key });
  assert.equal(first.statusCode, 200, first.body);
  const again = await f.pay(a.agentId, { idempotency_key: key });
  assert.equal(again.json().payment_id, first.json().payment_id);
  assert.equal(f.arc.state.signatures, 1, 'never signed twice');
  const other = await f.pay(a.agentId, { idempotency_key: key, amount: '3' });
  assert.equal(other.json().code, 'idempotency_conflict', other.body);

  // The same key on Base, from the same workspace: its own payment on its own chain.
  const onBase = await f.pay(b.agentId, { idempotency_key: key, recipient: 'CC-Bayo01' });
  assert.equal(onBase.statusCode, 200, onBase.body);
  assert.notEqual(onBase.json().payment_id, first.json().payment_id);
  const rows = await f.sql<{ chain_id: number }>(
    'SELECT chain_id FROM base_payments ORDER BY chain_id',
  );
  assert.deepEqual(
    rows.map((row) => Number(row.chain_id)).sort(),
    [ARC_MAINNET, WALLET_CHAIN_ID].sort(),
  );
});

test('a sponsor that is not Arc’s pinned one: refused, nothing signed or sent', async (t) => {
  const f = await setup(t);
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  f.arc.state.paymaster = 'foreign';
  const res = await f.pay(a.agentId);
  assert.equal(res.json().code, 'not_sponsored', res.body);
  assert.deepEqual(f.arc.state.sends, []);
  assert.equal(f.arc.state.signatures, 0);
});

test('a Base agent with Arc on: Base’s own chain, never screened, never Arc', async (t) => {
  const f = await setup(t);
  const b = await f.payerOn(f.base, 'Quay');
  await f.payeeOn(f.base, '501', 'Juno01');
  const res = await f.pay(b.agentId);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(f.base.state.sends.length, 1);
  assert.equal(f.arc.state.chains, 0);
  assert.deepEqual(f.screens, [], 'Base’s path asks no screening, as before');
  const read = await f.call('city_pay_status', { payment_id: res.json().payment_id });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(f.arc.state.chains, 0);
});

test('without the Arc side an Arc agent is still refused with other_chain', async (t) => {
  const f = await setup(t, { noArcSide: true });
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  const res = await f.pay(a.agentId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'other_chain');
  await nothingSent(f);
});

test('the app’s own Arc side with nothing configured: unavailable, naming Arc, nothing stored', async (t) => {
  const f = await setup(t, { live: true });
  const a = await f.payerOn(f.arc, 'Harbor');
  await f.payeeOn(f.arc, '501', 'Juno01');
  const res = await f.pay(a.agentId);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().code, 'unavailable');
  assert.match(res.json().error, /Arc/);
  assert.deepEqual(await f.sql('SELECT 1 FROM base_payments'), []);
});

test('the Arc gate as the app builds it: no oracle is no clearance, and the outage is said once', async (t) => {
  const f = await setup(t);
  const lines: string[] = [];
  const screen = arcScreening({
    db: f.db,
    env: {},
    chainId: ARC_MAINNET,
    now: Date.now,
    log: (line) => lines.push(line),
    provider: () => null,
    event: 'agent_pay.screening_unavailable',
    alertDetail: 'agent_pay_chain_test',
  });
  const request: ScreeningRequest = {
    chainId: ARC_MAINNET,
    token: ARC_NET.tokens.USDC.address,
    amountRaw: 1n,
    intentId: 'agent-pay:test',
    parties: [{ role: 'payee', address: `0x${'22'.repeat(20)}` }],
  };
  for (let i = 0; i < 2; i++) {
    const decision = await screen(request);
    assert.equal(decision.allowed, false);
    assert.equal(decision.outcome, 'unavailable');
  }
  assert.equal(lines.filter((line) => line.includes('agent_pay.screening_')).length, 1);
});

test('the recovery cron also ends an Arc payment cut off before its submit; Base’s answer is as it was', async (t) => {
  const f = await setup(t);
  const a = await f.payerOn(f.arc, 'Harbor');
  const r = await f.payeeOn(f.arc, '501', 'Juno01');
  const intent = intentFor(
    { workspaceId: f.payer.id, actorId: a.agentId },
    {
      chainId: ARC_MAINNET as never,
      source: { agentId: a.agentId },
      to: r.wallet.toLowerCase() as Address,
      token: ARC_NET.tokens.USDC.address as Address,
      amount: 1_000_000n,
      idempotencyKey: `agent-pay:${'a'.repeat(64)}`,
    },
    process.env,
  );
  const store = createPaymentIntentStore({ db: f.db, readPaymentReceipt, env: process.env });
  await store.reserve(intent);
  assert.equal((await store.begin(intent)).acquired, true);
  await f.sql('UPDATE base_payments SET updated_at = updated_at - $1', [RECOVERY_GRACE_MS + 1]);

  const res = await f.app.inject({
    url: PAY_RECOVER_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().complete, true);
  assert.equal(res.json().ended, 0, 'Base had nothing to do');
  assert.equal(res.json().arc.ended, 1);
  const [row] = await f.sql<{ state: string }>('SELECT state FROM base_payments');
  assert.equal(row!.state, 'failed');
  assert.deepEqual(f.arc.state.sends, []);
});

test('with Arc off the recovery answer has no Arc part', async (t) => {
  const f = await setup(t, { env: { ...FLAGS, CITY_ARC: undefined } });
  const res = await f.app.inject({
    url: PAY_RECOVER_PATH,
    headers: { authorization: `Bearer ${CRON}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(Object.hasOwn(res.json(), 'arc'), false);
});

test('the transfer intent: Base’s hash is unchanged; Arc exists only with Arc on', () => {
  const input = {
    source: { agentId: 'agent-1' },
    to: `0x${'22'.repeat(20)}` as Address,
    amount: 1_000_000n,
    idempotencyKey: 'agent-pay:key',
  };
  const actor = { workspaceId: 'ws-1', actorId: 'agent-1' };
  const base = intentFor(
    actor,
    {
      ...input,
      chainId: WALLET_CHAIN_ID,
      token: WALLET_NET.tokens.USDC.address as Address,
    },
    { CITY_BASE_MAINNET: '1' },
  );
  assert.equal(
    base.intentHash,
    // Computed before this change: Base's intent is the same bytes.
    '0x7d29e3b674a94bacc7deabb4b22a7ca849a36b7034650c724fdad9d1b0b6b460',
  );
  const arcInput = {
    ...input,
    chainId: ARC_MAINNET as never,
    token: ARC_NET.tokens.USDC.address as Address,
  };
  assert.throws(() => intentFor(actor, arcInput, { CITY_BASE_MAINNET: '1' }), /NETWORK_DISABLED/);
  assert.throws(() => intentFor(actor, arcInput), /NETWORK_DISABLED/);
  const arc = intentFor(actor, arcInput, { CITY_ARC: '1' });
  assert.notEqual(arc.intentHash, base.intentHash);
  // Base's own gate is untouched by Arc being on.
  assert.throws(
    () =>
      intentFor(
        actor,
        {
          ...input,
          chainId: WALLET_CHAIN_ID,
          token: WALLET_NET.tokens.USDC.address as Address,
        },
        { CITY_ARC: '1' },
      ),
    /NETWORK_DISABLED/,
  );
});
