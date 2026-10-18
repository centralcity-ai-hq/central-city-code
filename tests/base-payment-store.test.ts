import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
} from '../server/base/schema.js';
import type { ChainOpReceipt } from '../shared/base/types.js';
import { createPaymentIntentStore } from '../server/base/payments/store.js';
import { intentFor, type TransferInput } from '../server/base/payments/service.js';
import { BASE_NETWORKS, BASE_SEPOLIA } from '../shared/base/chains.js';
import { readPaymentReceipt } from '../server/base/chain/payment-receipt.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import { abandonBeforeBroadcast } from '../server/base/chain/submit.js';

const actor = { workspaceId: 'ws', actorId: 'actor' };
const input: TransferInput = {
  chainId: BASE_SEPOLIA,
  source: { agentId: 'a1' },
  to: '0x1111111111111111111111111111111111111111' as const,
  token: BASE_NETWORKS[BASE_SEPOLIA].tokens.USDC.address,
  amount: 5n,
  idempotencyKey: 'payment-1',
};

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('ws'),('other');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  await pg.exec(`INSERT INTO base_wallets (wallet_id,agent_id,operator_id,chain_id,address,
    owner_address,spender_address,spender_key_ref,derivation,state,created_at,updated_at)
    VALUES ('w1','a1','ws',84532,'0x${'1'.repeat(40)}','0x${'2'.repeat(40)}',
    '0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1)`);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return { db, store: () => createPaymentIntentStore({ db, now: () => 10 }) };
}

test('payment store observes the real chain reader and never-broadcast tombstone', async (t) => {
  const { db } = await setup(t);
  const store = createPaymentIntentStore({ db, readPaymentReceipt });
  const intent = intentFor(actor, input);
  await store.reserve(intent);
  await store.begin(intent);
  assert.equal((await store.observe(intent, null)).state, 'reconciling');
  await abandonBeforeBroadcast(pgChainOperationStore(db), {
    idempotencyKey: intent.operationKey,
    intentHash: intent.intentHash,
    chainId: intent.chainId,
    kind: 'transfer',
  });
  const result = await store.observe(intent, null);
  assert.equal(result.state, 'failed');
  assert.equal(result.receipt?.status, 'failed');
  assert.equal(result.receipt?.userOpHash, null);
  assert.equal(result.receipt?.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  const restarted = createPaymentIntentStore({ db, readPaymentReceipt });
  assert.equal((await restarted.begin(intent)).acquired, false);
  assert.equal((await restarted.observe(intent, null)).state, 'failed');
});

test('canonical reader finalizes only the matching agent operation', async (t) => {
  const { db } = await setup(t);
  const store = createPaymentIntentStore({ db, readPaymentReceipt });
  for (const matching of [false, true]) {
    const intent = intentFor(actor, { ...input, idempotencyKey: matching ? 'match' : 'mismatch' });
    await store.reserve(intent);
    await store.begin(intent);
    const sender = `0x${(matching ? '3' : '4').repeat(40)}` as const;
    await pgChainOperationStore(db).insert({
      idempotencyKey: intent.operationKey,
      intentHash: intent.intentHash,
      chainId: intent.chainId,
      kind: 'transfer',
      sender,
      signer: sender,
      nonce: '1',
      userOpHash: `0x${'aa'.repeat(32)}`,
      signedOperation: JSON.stringify({
        nonce: '1',
        maxPriorityFeePerGas: '1',
        initCode: '0x',
        callData: '0x',
        paymasterAndData: '0x',
        signature: '0x',
        sender,
        maxFeePerGas: '1',
        callGasLimit: '1',
        verificationGasLimit: '1',
        preVerificationGas: '1',
      }),
      status: 'final',
      txHash: `0x${'bb'.repeat(32)}`,
      blockNumber: '100',
      gasUsed: '3',
      feeWei: '3',
      maxCostWei: '3',
      submittedBlock: null,
      errorCode: null,
    });
    if (matching) {
      const result = await store.observe(intent, null);
      assert.equal(result.state, 'paid');
      assert.equal(result.receipt?.feeWei, 3n);
    } else {
      await assert.rejects(store.observe(intent, null), { code: 'NOT_THIS_AGENT' });
      assert.equal((await store.reserve(intent)).state, 'settling');
    }
  }
});

test('durable intent survives adapter recreation; concurrent begin has one winner', async (t) => {
  const f = await setup(t);
  const intent = intentFor(actor, input);
  const reservations = await Promise.all(
    Array.from({ length: 6 }, () => f.store().reserve(intent)),
  );
  assert.ok(reservations.every((r) => r.state === 'created'));
  const begins = await Promise.all(Array.from({ length: 6 }, () => f.store().begin(intent)));
  assert.equal(begins.filter((r) => r.acquired).length, 1);
  assert.equal((await f.store().reserve(intent)).state, 'settling');
  assert.equal((await f.store().begin(intent)).acquired, false);
  const { rows } = await f.db.query<{ n: number }>(
    'SELECT count(*)::integer AS n FROM base_payments',
  );
  assert.equal(rows[0].n, 1);
});

test('observation uses canonical state, never the supplied stale receipt', async (t) => {
  const f = await setup(t);
  const intent = intentFor(actor, input);
  const receipt: ChainOpReceipt = {
    opId: 'operation-row',
    idempotencyKey: intent.operationKey,
    status: 'final',
    userOpHash: null,
    txHash: null,
    blockNumber: 5n,
    gasUsed: 1n,
    feeWei: 2n,
    errorCode: null,
  };
  let current: ChainOpReceipt | null = receipt;
  const store = createPaymentIntentStore({
    db: f.db,
    readPaymentReceipt: async (tx, identity) => {
      assert.equal(identity.workspaceId, actor.workspaceId);
      assert.equal(identity.agentId, 'a1');
      await tx.query('SELECT 1');
      return current;
    },
  });
  await store.reserve(intent);
  await store.begin(intent);
  assert.equal((await store.observe(intent, { ...receipt, status: 'unknown' })).state, 'paid');
  current = null;
  assert.equal((await store.observe(intent, null)).state, 'paid');
  current = { ...receipt, status: 'failed' };
  await assert.rejects(store.observe(intent, receipt), { code: 'TERMINAL_RECEIPT_CONFLICT' });
  assert.equal((await f.store().reserve(intent)).state, 'paid');
});

test('failed canonical operations persist and reader failures roll back observation', async (t) => {
  const f = await setup(t);
  const intent = intentFor(actor, input);
  const failed: ChainOpReceipt = {
    opId: 'failed-op',
    idempotencyKey: intent.operationKey,
    status: 'failed',
    userOpHash: null,
    txHash: null,
    blockNumber: null,
    gasUsed: null,
    feeWei: null,
    errorCode: 'ABANDONED_BEFORE_BROADCAST',
  };
  let throws = true;
  const store = createPaymentIntentStore({
    db: f.db,
    readPaymentReceipt: async () => {
      if (throws) throw new Error('canonical store unavailable');
      return failed;
    },
  });
  await store.reserve(intent);
  await store.begin(intent);
  await assert.rejects(store.observe(intent, null), /canonical store unavailable/);
  assert.equal((await f.store().reserve(intent)).state, 'settling');
  throws = false;
  assert.equal((await store.observe(intent, null)).state, 'failed');
  await assert.rejects(store.observe(intent, { ...failed, idempotencyKey: 'foreign' }), {
    code: 'RECEIPT_MISMATCH',
  });
});

test('conflicting immutable intent and forged hashes never overwrite a payment', async (t) => {
  const f = await setup(t);
  const intent = intentFor(actor, input);
  await f.store().reserve(intent);
  for (const altered of [
    intentFor(actor, { ...input, amount: 6n }),
    intentFor({ ...actor, actorId: 'other' }, input),
    { ...intent, operationKey: 'forged' },
    { ...intent, amount: '6' },
  ]) {
    await assert.rejects(f.store().reserve(altered), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.equal((await f.store().reserve(intent)).intent.amount, '5');
});

test('foreign workspace, frozen wallet, noncanonical amounts and fleet sources fail closed', async (t) => {
  const f = await setup(t);
  const intent = intentFor(actor, input);
  await assert.rejects(f.store().reserve(intentFor({ ...actor, workspaceId: 'other' }, input)), {
    code: 'SOURCE_UNAVAILABLE',
  });
  for (const amount of ['05', '5.1', '1e2', '-1']) {
    await assert.rejects(f.store().reserve({ ...intent, amount }), { code: 'INVALID_AMOUNT' });
  }
  await assert.rejects(
    f.store().reserve(intentFor(actor, { ...input, source: { fleetJobId: 'job' } })),
    { code: 'FLEET_ALLOCATION_REQUIRED' },
  );
  await f.db.query("UPDATE base_wallets SET state='frozen'");
  await assert.rejects(f.store().reserve(intent), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(f.store().begin(intent), { code: 'PAYMENT_NOT_FOUND' });
});
