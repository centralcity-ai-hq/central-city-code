import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { recoverMessageAddress, type Hex } from 'viem';
import type { Database } from '../server/database.js';
import { BASE_SEPOLIA, baseNetwork } from '../shared/base/chains.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
} from '../server/base/schema.js';
import { createKeystore, parseKeks } from '../server/base/chain/keystore.js';
import {
  ORPHAN_KEY_AGE_MS,
  pgAuthorizationStore,
  pgChainOperationStore,
  pgSpenderKeyStore,
} from '../server/base/chain/stores.js';
import type { StoredOperation } from '../server/base/chain/submit.js';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  return { db };
}

const signed = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: '7',
  initCode: '0x',
  callData: '0xabcd',
  callGasLimit: '100000',
  verificationGasLimit: '200000',
  preVerificationGas: '50000',
  maxFeePerGas: '1000',
  maxPriorityFeePerGas: '10',
  paymasterAndData: '0x1234',
  signature: '0x99',
};

const row = (key: string, intent = `0x${'11'.repeat(32)}`): StoredOperation => ({
  idempotencyKey: key,
  intentHash: intent as Hex,
  chainId: 84532,
  kind: 'transfer',
  sender: signed.sender as Hex,
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '7',
  userOpHash: `0x${'aa'.repeat(32)}`,
  signedOperation: JSON.stringify(signed),
  status: 'queued',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: null,
  errorCode: null,
});

test('chain operations: stored before broadcast, first insert wins, identity immutable', async (t) => {
  const { db } = await setup(t);
  const store = pgChainOperationStore(db, () => 5_000);
  const stored = await store.insert(row('op:1'));
  assert.equal(stored.signedOperation, JSON.stringify(signed));
  assert.equal(stored.sender, '0x1111111111111111111111111111111111111111');
  // (100000 + 200000 × 3 [paymaster] + 50000) × 1000 — derived from the signed op, not trusted input.
  assert.equal(stored.maxCostWei, (750_000n * 1000n).toString());

  // A concurrent insert with the same key returns what is stored, not its own row.
  const loser = await store.insert(row('op:1', `0x${'22'.repeat(32)}`));
  assert.equal(loser.intentHash, `0x${'11'.repeat(32)}`);

  const updated = await store.update('op:1', {
    status: 'included',
    txHash: `0x${'bb'.repeat(32)}`,
    blockNumber: '42',
    gasUsed: '123',
    feeWei: '456',
  });
  assert.equal(updated.status, 'included');
  assert.equal(updated.blockNumber, '42');
  assert.equal(updated.feeWei, '456');
  await assert.rejects(
    store.update('op:1', { intentHash: `0x${'33'.repeat(32)}` }),
    /cannot be updated/,
  );
  await assert.rejects(store.update('op:1', { signedOperation: '{}' }), /cannot be updated/);
  await assert.rejects(store.update('missing', { status: 'final' }), /No stored operation/);
  assert.equal(await store.get('missing'), null);
});

test('spender keys: encrypted round trip through Postgres; signer matches', async (t) => {
  const { db } = await setup(t);
  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({
    store: keyStore,
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
  });
  const { signer, keyRef } = await keystore.createSpenderKey();
  const signature = await keystore.withSigner(keyRef, (account) =>
    account.signMessage({ message: 'pg' }),
  );
  assert.equal(await recoverMessageAddress({ message: 'pg', signature }), signer);
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM base_spender_keys WHERE ciphertext IS NOT NULL',
  );
  assert.equal(rows[0].n, 1);
});

test('orphan cleanup: only old, uncommitted, unreferenced keys are deleted', async (t) => {
  const { db } = await setup(t);
  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({
    store: keyStore,
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    now: () => 0,
  });
  const orphan = await keystore.createSpenderKey();
  const committed = await keystore.createSpenderKey();
  const referenced = await keystore.createSpenderKey();
  await keyStore.commit(committed.keyRef, 10);
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$1,$1,$2,'{}','derived',0,0)`,
    ['0x1111111111111111111111111111111111111111', referenced.keyRef],
  );
  const fresh = await createKeystore({
    store: keyStore,
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
    now: () => ORPHAN_KEY_AGE_MS + 1,
  }).createSpenderKey();

  assert.equal(await keyStore.deleteOrphans(ORPHAN_KEY_AGE_MS + 1), 1);
  const ids = (await db.query<{ key_id: string }>('SELECT key_id FROM base_spender_keys')).rows
    .map((r) => r.key_id)
    .sort();
  const idOf = (ref: string) => ref.split(':')[1];
  assert.deepEqual(
    ids,
    [idOf(committed.keyRef), idOf(referenced.keyRef), idOf(fresh.keyRef)].sort(),
  );
  assert.equal(ids.includes(idOf(orphan.keyRef)), false);
});

test('chain operations: the submission block is stored and read back', async (t) => {
  const { db } = await setup(t);
  const store = pgChainOperationStore(db);
  assert.equal(
    (await store.insert({ ...row('op:b'), submittedBlock: '123456' })).submittedBlock,
    '123456',
  );
  assert.equal((await store.get('op:b'))?.submittedBlock, '123456');
  // Unknown stays unknown: absence is then never concluded.
  assert.equal((await store.insert(row('op:c'))).submittedBlock, null);
});

test('chain operations: the search cursor only moves forward, null clears it, nothing else changes', async (t) => {
  const { db } = await setup(t);
  const store = pgChainOperationStore(db, () => 5_000);
  const inserted = await store.insert({ ...row('op:s'), submittedBlock: '100' });
  assert.equal(inserted.searchedBlock, null);
  await store.recordSearched!('op:s', '3099');
  assert.equal((await store.get('op:s'))?.searchedBlock, '3099');
  // A slower refresh that searched less never moves it back.
  await store.recordSearched!('op:s', '1099');
  assert.equal((await store.get('op:s'))?.searchedBlock, '3099');
  await store.recordSearched!('op:s', '6099');
  const advanced = await store.get('op:s');
  assert.equal(advanced?.searchedBlock, '6099');
  // The status, the receipt and the write time are never touched.
  assert.equal(advanced?.status, inserted.status);
  assert.equal(advanced?.updatedAt, inserted.updatedAt);
  assert.equal(advanced?.blockNumber, null);
  await store.recordSearched!('op:s', null);
  assert.equal((await store.get('op:s'))?.searchedBlock, null);
});

test('x402 authorizations: stored once per intent, lowercase, returned unchanged', async (t) => {
  const { db } = await setup(t);
  const store = pgAuthorizationStore(db, () => 1);
  const issued = {
    paymentIntentId: 'intent-1',
    chainId: BASE_SEPOLIA,
    token: baseNetwork(BASE_SEPOLIA)!.tokens.USDC.address,
    authorization: {
      from: '0xAbCdEf0000000000000000000000000000000001' as Hex,
      to: '0x00000000000000000000000000000000000000Ff' as Hex,
      value: 10_000n,
      validAfter: 100n,
      validBefore: 200n,
      nonce: `0x${'Ab'.repeat(32)}` as Hex,
    },
    signature: '0xdeadbeef' as Hex,
  };
  const first = await store.insert(issued);
  assert.equal(first.authorization.value, 10_000n);
  assert.equal(first.authorization.nonce, `0x${'ab'.repeat(32)}`);
  assert.equal(first.signature, '0xdeadbeef');
  // A second insert for the same intent returns the stored one, never the new values.
  const second = await store.insert({
    ...issued,
    authorization: { ...issued.authorization, validBefore: 999n },
    signature: '0x01',
  });
  assert.deepEqual(second, first);
  assert.deepEqual(await store.get('intent-1'), first);
  assert.equal(await store.get('missing'), null);
  const { rows } = await db.query<{ token: string; from_address: string }>(
    'SELECT token, from_address FROM base_x402_authorizations',
  );
  assert.deepEqual(rows, [
    { token: issued.token.toLowerCase(), from_address: issued.authorization.from.toLowerCase() },
  ]);
});
