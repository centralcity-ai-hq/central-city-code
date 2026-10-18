import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_FLEET_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
} from '../server/base/schema.js';
import {
  PaymentReceiptError,
  readBatchReceipt,
  readPaymentReceipt,
} from '../server/base/chain/payment-receipt.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import { abandonBeforeBroadcast, type StoredOperation } from '../server/base/chain/submit.js';

const SPENDER = '0x1111111111111111111111111111111111111111';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1'), ('ws-2');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_FLEET_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$1,$2,'v1:k','{}','derived',0,0)`,
    [`0x${'2'.repeat(40)}`, SPENDER],
  );
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return { db };
}

const intentHash = `0x${'11'.repeat(32)}` as Hex;
const signed = JSON.stringify({
  sender: SPENDER,
  nonce: '7',
  initCode: '0x',
  callData: '0xabcd',
  callGasLimit: '1',
  verificationGasLimit: '1',
  preVerificationGas: '1',
  maxFeePerGas: '1',
  maxPriorityFeePerGas: '1',
  paymasterAndData: '0x',
  signature: '0x99',
});
const op = (overrides: Partial<StoredOperation> = {}): StoredOperation => ({
  idempotencyKey: 'payment:1',
  intentHash,
  chainId: 84532,
  kind: 'transfer',
  sender: SPENDER,
  signer: '0x3333333333333333333333333333333333333333',
  nonce: '7',
  userOpHash: `0x${'aa'.repeat(32)}`,
  signedOperation: signed,
  status: 'final',
  txHash: `0x${'bb'.repeat(32)}`,
  blockNumber: '100',
  gasUsed: '21000',
  feeWei: '5',
  maxCostWei: '0',
  submittedBlock: null,
  errorCode: null,
  ...overrides,
});
const query = {
  operationKey: 'payment:1',
  intentHash,
  workspaceId: 'ws-1',
  chainId: 84532,
  agentId: 'a-1',
};

test('receipt: the stored outcome, receipt fields only, inside the caller transaction', async (t) => {
  const { db } = await setup(t);
  assert.equal(await db.transaction((tx) => readPaymentReceipt(tx, query)), null);
  await pgChainOperationStore(db).insert(op());
  const receipt = await db.transaction((tx) => readPaymentReceipt(tx, query));
  assert.deepEqual(receipt, {
    opId: 'payment:1',
    idempotencyKey: 'payment:1',
    status: 'final',
    userOpHash: `0x${'aa'.repeat(32)}`,
    txHash: `0x${'bb'.repeat(32)}`,
    blockNumber: 100n,
    gasUsed: 21000n,
    feeWei: 5n,
    errorCode: null,
  });
  // Nothing signed, no signer, no key material leaves the chain module.
  assert.ok(
    !JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)).includes('0x99'),
  );
});

test('receipt: another intent, network, workspace or agent is refused', async (t) => {
  const { db } = await setup(t);
  await pgChainOperationStore(db).insert(op());
  const refused = (q: typeof query, code: string) =>
    assert.rejects(
      db.transaction((tx) => readPaymentReceipt(tx, q)),
      (e: unknown) => e instanceof PaymentReceiptError && e.code === code,
    );
  await refused({ ...query, intentHash: `0x${'22'.repeat(32)}` }, 'INTENT_MISMATCH');
  await refused({ ...query, chainId: 8453 }, 'WRONG_NETWORK');
  await refused({ ...query, workspaceId: 'ws-2' }, 'NOT_THIS_AGENT');
  await refused({ ...query, agentId: 'a-2' }, 'NOT_THIS_AGENT');
});

test('receipt: a never-sent tombstone reads as failed without a sender check', async (t) => {
  const { db } = await setup(t);
  await abandonBeforeBroadcast(pgChainOperationStore(db), {
    idempotencyKey: 'payment:1',
    intentHash,
    chainId: 84532,
    kind: 'transfer',
  });
  const receipt = await db.transaction((tx) => readPaymentReceipt(tx, query));
  assert.equal(receipt?.status, 'failed');
  assert.equal(receipt?.errorCode, 'ABANDONED_BEFORE_BROADCAST');
  assert.equal(receipt?.userOpHash, null);
});

// A funded fleet batch: one UserOp sent from the job's treasury wallet's spender account.
const TREASURY_SPENDER = '0x4444444444444444444444444444444444444444';
async function withBatch(db: Database) {
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-t','treasury','ws-1',84532,$1,$1,$2,'v1:t','{}','derived',0,0)`,
    [`0x${'5'.repeat(40)}`, TREASURY_SPENDER],
  );
  await db.query(
    `INSERT INTO base_fleet_jobs (job_id, operator_id, chain_id, treasury_wallet_id, run_nonce,
       intent_hash, intent, signature, manifest_hash, registration_mode, expires_at, state,
       created_at, updated_at)
     VALUES ('job-1','ws-1',84532,'w-t','1','0xrun','{}',$1,'0xmanifest','lazy',9,'running',0,0)`,
    [Buffer.from([0])],
  );
  await db.query(
    `INSERT INTO base_fleet_batches (job_id, batch_no, operation_key, intent_hash, state,
       created_at, updated_at)
     VALUES ('job-1', 0, 'fleet:job-1:0', $1, 'pending', 0, 0)`,
    [intentHash],
  );
}
/** A signed operation actually sent from the treasury spender (the store derives the sender from it). */
const fromTreasury = {
  kind: 'batch',
  sender: TREASURY_SPENDER,
  signedOperation: signed.replace(SPENDER, TREASURY_SPENDER),
} as const;
const batchQuery = { workspaceId: 'ws-1', chainId: 84532, jobId: 'job-1', batchNo: 0 };

test('batch receipt: bound to the batch key and the treasury sender, fields only', async (t) => {
  const { db } = await setup(t);
  await withBatch(db);
  assert.equal(await db.transaction((tx) => readBatchReceipt(tx, batchQuery)), null);
  await pgChainOperationStore(db).insert(op({ idempotencyKey: 'fleet:job-1:0', ...fromTreasury }));
  const receipt = await db.transaction((tx) => readBatchReceipt(tx, batchQuery));
  assert.equal(receipt?.status, 'final');
  assert.equal(receipt?.idempotencyKey, 'fleet:job-1:0');
  assert.equal(receipt?.feeWei, 5n);
});

test('batch receipt: another workspace, network, batch or sender is refused', async (t) => {
  const { db } = await setup(t);
  await withBatch(db);
  const refused = (q: typeof batchQuery, code: string) =>
    assert.rejects(
      db.transaction((tx) => readBatchReceipt(tx, q)),
      (e: unknown) => e instanceof PaymentReceiptError && e.code === code,
    );
  await refused({ ...batchQuery, workspaceId: 'ws-2' }, 'BATCH_NOT_FOUND');
  await refused({ ...batchQuery, chainId: 8453 }, 'BATCH_NOT_FOUND');
  await refused({ ...batchQuery, batchNo: 1 }, 'BATCH_NOT_FOUND');
  // Sent by a recipient agent's spender instead of the treasury's: never accepted as the batch.
  await pgChainOperationStore(db).insert(
    op({ idempotencyKey: 'fleet:job-1:0', kind: 'batch', sender: SPENDER }),
  );
  await refused(batchQuery, 'NOT_THIS_TREASURY');
});

test('batch receipt: a stored operation for another intent is refused', async (t) => {
  const { db } = await setup(t);
  await withBatch(db);
  await pgChainOperationStore(db).insert(
    op({
      idempotencyKey: 'fleet:job-1:0',
      ...fromTreasury,
      intentHash: `0x${'99'.repeat(32)}`,
    }),
  );
  await assert.rejects(
    db.transaction((tx) => readBatchReceipt(tx, batchQuery)),
    (e: unknown) => e instanceof PaymentReceiptError && e.code === 'INTENT_MISMATCH',
  );
});

test('batch receipt: an operation or tombstone of another kind under the batch key is refused', async (t) => {
  const { db } = await setup(t);
  await withBatch(db);
  await pgChainOperationStore(db).insert(
    op({ idempotencyKey: 'fleet:job-1:0', ...fromTreasury, kind: 'transfer' }),
  );
  await assert.rejects(
    db.transaction((tx) => readBatchReceipt(tx, batchQuery)),
    (e: unknown) => e instanceof PaymentReceiptError && e.code === 'WRONG_KIND',
  );
  const other = await setup(t);
  await withBatch(other.db);
  await abandonBeforeBroadcast(pgChainOperationStore(other.db), {
    idempotencyKey: 'fleet:job-1:0',
    intentHash,
    chainId: 84532,
    kind: 'transfer',
  });
  await assert.rejects(
    other.db.transaction((tx) => readBatchReceipt(tx, batchQuery)),
    (e: unknown) => e instanceof PaymentReceiptError && e.code === 'WRONG_KIND',
  );
});

test('receipt: a batch operation under a payment key is refused', async (t) => {
  const { db } = await setup(t);
  await pgChainOperationStore(db).insert(op({ kind: 'batch' }));
  await assert.rejects(
    db.transaction((tx) => readPaymentReceipt(tx, query)),
    (e: unknown) => e instanceof PaymentReceiptError && e.code === 'WRONG_KIND',
  );
});

test('store: a guarded write applies only while the row carries the expected receipt', async (t) => {
  const { db } = await setup(t);
  const store = pgChainOperationStore(db);
  const r1 = { txHash: `0x${'bb'.repeat(32)}` as Hex, blockNumber: '100', errorCode: null };
  await store.insert(op({ status: 'included', ...r1 }));
  // Decided on another receipt: refused, the row is unchanged.
  const stale = await store.transition(
    'payment:1',
    ['included'],
    { status: 'final' },
    {
      ...r1,
      blockNumber: '99',
    },
  );
  assert.equal(stale, null);
  assert.equal((await store.get('payment:1'))?.status, 'included');
  assert.equal(
    await store.transition(
      'payment:1',
      ['included'],
      { status: 'final' },
      {
        ...r1,
        errorCode: 'USEROP_REVERTED',
      },
    ),
    null,
  );
  // Decided on the stored receipt: applied.
  const fresh = await store.transition('payment:1', ['included'], { status: 'final' }, r1);
  assert.equal(fresh?.status, 'final');
});
