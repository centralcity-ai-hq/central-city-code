import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { getAddress } from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_WALLET_PAYMENTS_SQL,
  BASE_WALLET_VAULT_SQL,
  BASE_WALLET_WITHDRAWALS_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { registerBaseWalletRoutes } from '../server/base/wallet/routes.js';
import type { ChainRuntime } from '../server/base/identity/routes.js';
import { AGENT_URI_ORIGIN } from '../shared/base/on-base.js';
import { PAY_BY_AGENT_MAX } from '../shared/base/pay.js';
import { WALLET_EXPECTED, WALLET_NET } from './wallet-network-fixture.js';

/*
 * Base Pay P2d: the payments an agent made on its own, read by its wallet's owner account only
 * (GET /api/base/agents/:agentId/wallet/agent-payments). Read only, rows that exist: the
 * base_payments rows the payment service writes (payments/store.ts), inserted here directly.
 * Synthetic ids, addresses and hashes only.
 */

const CHAIN_ID = WALLET_EXPECTED.chainId;
const REGISTRY = WALLET_EXPECTED.registry;
const USDC = WALLET_NET.tokens.USDC.address;
// person-1's agent pays; person-2's agent receives (and has an agent of its own that pays).
const PAYER = '0a0a0a0a-0000-4000-8000-00000000000a';
const PAYEE = '0b0b0b0b-0000-4000-8000-00000000000b';
const OTHER_PAYER = '0c0c0c0c-0000-4000-8000-00000000000c';
const WALLET_PAYER = getAddress(`0x${'1a'.repeat(20)}`);
const WALLET_PAYEE = getAddress(`0x${'2b'.repeat(20)}`);
const WALLET_OTHER = getAddress(`0x${'3c'.repeat(20)}`);
const UNKNOWN = getAddress(`0x${'4d'.repeat(20)}`);
const TX = `0x${'ab'.repeat(32)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const path = (agentId: string) => `/api/base/agents/${agentId}/wallet/agent-payments`;

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  env = { CITY_BASE_WALLET: '1' },
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(`CREATE TABLE operators (id text PRIMARY KEY, kind text NOT NULL);
    INSERT INTO operators VALUES ('person-1','owner'), ('person-2','owner'), ('ai-1','ai');
    CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL);
    INSERT INTO workspaces VALUES ('person-1', '{"agents": []}'), ('person-2', '{"agents": []}');
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
  ])
    await pg.exec(sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };

  const wallet = (id: string, agentId: string, account: string, address: string) =>
    pg.query(
      `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
         spender_address, spender_key_ref, derivation, state, created_at, updated_at,
         owner_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'v1:00000000-0000-4000-8000-000000000000','{}','derived',1,1,$3)`,
      [id, agentId, account, CHAIN_ID, address, `0x${'e'.repeat(40)}`, `0x${'f'.repeat(40)}`],
    );
  await wallet('w-payer', PAYER, 'person-1', WALLET_PAYER);
  await wallet('w-payee', PAYEE, 'person-2', WALLET_PAYEE);
  await wallet('w-other', OTHER_PAYER, 'person-2', WALLET_OTHER);

  // The recipient: a confirmed registration on the wallet network with a public card name.
  await pg.query(`INSERT INTO agent_manifests VALUES ($1, 'person-2', 1, $2)`, [
    PAYEE,
    JSON.stringify({ metadata: { displayName: 'Mischke' }, spec: { visibility: 'public' } }),
  ]);
  await pg.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', (data->'agents') || $1::jsonb)
     WHERE operator_id = 'person-2'`,
    [JSON.stringify([{ id: PAYEE, revision: 1, revokedAt: null }])],
  );
  await pg.query(`INSERT INTO base_short_ids VALUES ('Misch1', $1, 1)`, [PAYEE]);
  await pg.query(
    `INSERT INTO base_identities (agent_id, chain_id, operator_id, registry_address,
       erc8004_agent_id, agent_card_uri, owner_of_identity, state, op_id, updated_at,
       register_op_id, mint_op_id, provisional_agent_id, mint_seen_at, mint_finality,
       transfer_op_id, handover_id, handover_finality, started_at)
     VALUES ($1, $2, 'person-2', $3, 501, $4, $5, 'confirmed', $6, 1, $7, $7, 501, 1, 'final', $6,
       501, 'final', 1)`,
    [
      PAYEE,
      CHAIN_ID,
      REGISTRY,
      `${AGENT_URI_ORIGIN}/a/Misch1`,
      WALLET_PAYEE,
      `identity:transfer:${CHAIN_ID}:${PAYEE}~501`,
      `identity:register:${CHAIN_ID}:${PAYEE}`,
    ],
  );

  let n = 0;
  /** A base_payments row as payments/store.ts writes one (agent source, transfer, USDC). */
  const payment = async (p: {
    id: string;
    walletId?: string;
    workspace?: string;
    agentId?: string;
    to?: string;
    amount?: string;
    state?: string;
    sourceKind?: 'agent' | 'fleet';
    kind?: 'transfer' | 'x402';
    token?: string;
    chainId?: number;
    settleOp?: string | null;
    at: number;
  }) => {
    n += 1;
    await pg.query(
      `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind,
         source_ref, payer_wallet_id, intent_version, intent_hash, idempotency_key, token_address,
         recipient_address, amount, kind, state, settle_op_id, created_at, updated_at)
       VALUES ($1,$2,$3,'workspace key k-1',$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        p.id,
        p.workspace ?? 'person-1',
        p.chainId ?? CHAIN_ID,
        p.sourceKind ?? 'agent',
        p.agentId ?? PAYER,
        p.walletId ?? 'w-payer',
        hash(n),
        `agent-pay:${p.id}`,
        p.token ?? USDC,
        p.to ?? WALLET_PAYEE,
        p.amount ?? '100000',
        p.kind ?? 'transfer',
        p.state ?? 'created',
        p.settleOp ?? null,
        p.at,
        p.at + 5,
      ],
    );
    return hash(n);
  };
  const operation = (key: string, intentHash: string, status: string, txHash: string | null) =>
    pg.query(
      `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, operator_id, kind, chain_id,
         status, tx_hash, created_at, updated_at)
       VALUES ($1, $1, $2, 'person-1', 'transfer', $3, $4, $5, 1, 1)`,
      [key, intentHash, CHAIN_ID, status, txHash],
    );

  const runtime: ChainRuntime = {
    walletPort: {} as ChainRuntime['walletPort'],
    identityPort: {} as ChainRuntime['identityPort'],
  };
  const app = Fastify();
  t.after(() => app.close());
  registerBaseWalletRoutes(app, {
    db,
    env,
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
  });
  const read = (agentId: string, person?: string, workspace?: string) =>
    app.inject({
      url: path(agentId),
      headers: {
        ...(person ? { 'x-test-person': person } : {}),
        ...(workspace ? { 'x-city-workspace': workspace } : {}),
      },
    });
  return { pg, app, payment, operation, read };
}

test('an agent payment is listed for its wallet owner as by agent, with recipient, state and tx', async (t) => {
  const f = await setup(t);
  const paidIntent = await f.payment({
    id: 'p-paid',
    state: 'paid',
    settleOp: 'payment:op-paid',
    at: 1_000,
  });
  await f.operation('payment:op-paid', paidIntent, 'final', TX);
  const includedIntent = await f.payment({
    id: 'p-included',
    state: 'reconciling',
    settleOp: 'payment:op-included',
    amount: '2500000',
    at: 2_000,
  });
  await f.operation('payment:op-included', includedIntent, 'included', null);
  // To a wallet no confirmed registration names: the wallet alone, no name or Base ID.
  await f.payment({ id: 'p-unknown', state: 'settling', to: UNKNOWN, at: 3_000 });
  await f.payment({ id: 'p-failed', state: 'failed', at: 4_000 });

  const res = await f.read(PAYER, 'person-1');
  assert.equal(res.statusCode, 200);
  const body = res.json() as { payments: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(body), ['payments']);
  assert.deepEqual(
    body.payments.map((p) => [p.paymentId, p.state]),
    [
      ['p-failed', 'failed'],
      ['p-unknown', 'pending'],
      ['p-included', 'included'],
      ['p-paid', 'final'],
    ],
  );
  assert.ok(body.payments.every((p) => p.by === 'agent'));
  // No `safe`: base_payments has no such field, so it is never sent.
  assert.ok(body.payments.every((p) => !('safe' in p)));
  const paid = body.payments.find((p) => p.paymentId === 'p-paid')!;
  assert.deepEqual(paid, {
    paymentId: 'p-paid',
    by: 'agent',
    state: 'final',
    to: { agentId: PAYEE, name: 'Mischke', baseId: '501', short: 'Misch1', wallet: WALLET_PAYEE },
    token: 'USDC',
    amount: { raw: '100000', decimals: 6, display: '0.1' },
    txHash: TX,
    explorerUrl: `${WALLET_EXPECTED.explorer}/tx/${TX}`,
    createdAt: 1_000,
    updatedAt: 1_005,
  });
  assert.deepEqual(body.payments.find((p) => p.paymentId === 'p-unknown')!.to, {
    agentId: null,
    name: '',
    baseId: null,
    short: null,
    wallet: UNKNOWN,
  });
  const included = body.payments.find((p) => p.paymentId === 'p-included')!;
  assert.equal(included.txHash, null);
  assert.deepEqual(included.amount, { raw: '2500000', decimals: 6, display: '2.5' });
});

test('another owner, a co-owner workspace, an AI account or no session never reads it', async (t) => {
  const f = await setup(t);
  await f.payment({ id: 'p-1', at: 1_000 });
  // person-2's own agent pays too: only person-2 reads that one.
  await f.payment({
    id: 'p-other',
    walletId: 'w-other',
    workspace: 'person-2',
    agentId: OTHER_PAYER,
    to: WALLET_PAYER,
    at: 2_000,
  });

  assert.equal((await f.read(PAYER, 'person-2')).statusCode, 404);
  // Acting in person-1's workspace changes nothing: the wallet's owner account decides.
  assert.equal((await f.read(PAYER, 'person-2', 'person-1')).statusCode, 404);
  assert.equal((await f.read(PAYER, 'ai-1')).statusCode, 404);
  assert.equal((await f.read(PAYER)).statusCode, 401);
  assert.equal((await f.read(OTHER_PAYER, 'person-1')).statusCode, 404);
  assert.equal((await f.read('not-a-uuid', 'person-1')).statusCode, 404);

  const mine = (await f.read(PAYER, 'person-1')).json() as {
    payments: Array<{ paymentId: string }>;
  };
  assert.deepEqual(
    mine.payments.map((p) => p.paymentId),
    ['p-1'],
  );
  const theirs = (await f.read(OTHER_PAYER, 'person-2')).json() as {
    payments: Array<{ paymentId: string; to: { wallet: string } }>;
  };
  assert.deepEqual(
    theirs.payments.map((p) => p.paymentId),
    ['p-other'],
  );
  // An agent with a wallet but no payments: an empty list, never someone else's.
  assert.deepEqual((await f.read(PAYEE, 'person-2')).json(), { payments: [] });
});

test('only agent transfers in USDC from this wallet; owner payments are not listed and stay as they are', async (t) => {
  const f = await setup(t);
  await f.payment({ id: 'p-agent', at: 1_000 });
  await f.payment({ id: 'p-fleet', sourceKind: 'fleet', at: 2_000 });
  await f.payment({ id: 'p-x402', kind: 'x402', at: 3_000 });
  await f.payment({ id: 'p-token', token: `0x${'99'.repeat(20)}`, at: 4_000 });
  // The same agent id under another workspace's operator: not this wallet's payment.
  await f.payment({ id: 'p-elsewhere', workspace: 'person-2', at: 5_000 });
  // A recorded op whose intent is another payment's: its transaction is never borrowed.
  await f.payment({ id: 'p-borrowed', state: 'paid', settleOp: 'payment:op-x', at: 6_000 });
  await f.operation('payment:op-x', hash(999), 'final', TX);
  // The owner's own Pay payment: an owner withdrawal with its payment record.
  await f.pg.query(
    `INSERT INTO base_wallet_withdrawals (withdrawal_id, wallet_id, owner_account_id, chain_id,
       token, amount_raw, destination, idempotency_key, request_hash, state, nonce, user_operation,
       user_op_hash, expires_at, created_at, updated_at)
     VALUES ('wd-owner', 'w-payer', 'person-1', $1, 'USDC', 300000, $2, 'k-owner', $3,
       'awaiting_signature', 0, '{}', $3, 9, 7000, 7000)`,
    [CHAIN_ID, UNKNOWN, hash(42)],
  );
  await f.pg.query(
    `INSERT INTO base_wallet_payments (payment_id, withdrawal_id, chain_id, owner_account_id,
       sender_wallet_id, sender_agent_id, idempotency_key, request_hash, token, amount_raw,
       recipient_kind, recipient_address, created_at)
     VALUES ('p-owner', 'wd-owner', $1, 'person-1', 'w-payer', $2, 'k-owner', $3, 'USDC', 300000,
       'address', $4, 7000)`,
    [CHAIN_ID, PAYER, hash(42), UNKNOWN],
  );
  const owner = await f.pg.query('SELECT * FROM base_wallet_payments');

  const body = (await f.read(PAYER, 'person-1')).json() as {
    payments: Array<{ paymentId: string; by: string; txHash: string | null }>;
  };
  assert.deepEqual(
    body.payments.map((p) => [p.paymentId, p.by, p.txHash]),
    [
      ['p-borrowed', 'agent', null],
      ['p-agent', 'agent', null],
    ],
  );
  // Read only: the owner's rows are exactly as they were.
  assert.deepEqual((await f.pg.query('SELECT * FROM base_wallet_payments')).rows, owner.rows);
});

test('newest first, at most PAY_BY_AGENT_MAX; 404 while wallets are off', async (t) => {
  const f = await setup(t);
  for (let i = 0; i < PAY_BY_AGENT_MAX + 3; i += 1)
    await f.payment({ id: `p-${String(i).padStart(2, '0')}`, at: 1_000 + i });
  const body = (await f.read(PAYER, 'person-1')).json() as {
    payments: Array<{ paymentId: string }>;
  };
  assert.equal(body.payments.length, PAY_BY_AGENT_MAX);
  assert.equal(body.payments[0].paymentId, `p-${PAY_BY_AGENT_MAX + 2}`);

  const off = await setup(t, { CITY_BASE_WALLET: '0' });
  await off.payment({ id: 'p-1', at: 1_000 });
  assert.equal((await off.read(PAYER, 'person-1')).statusCode, 404);
});
