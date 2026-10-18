import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { type Hex, type PublicClient } from 'viem';
import type { UserOperation } from 'viem/account-abstraction';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import { BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';
import {
  createIdentityChainPort,
  identityNonceLane,
  registerIntentHash,
  transferIntentHash,
} from '../server/base/chain/identity-port.js';
import { createKeystore, parseKeks, parseKeyRef } from '../server/base/chain/keystore.js';
import { createWalletChainPort } from '../server/base/chain/port.js';
import { pgChainOperationStore, pgSpenderKeyStore } from '../server/base/chain/stores.js';
import { fromJson, type Bundler, type StoredOperation } from '../server/base/chain/submit.js';
import { handoverKey, registerKey } from '../server/base/identity/service.js';

// An identity operation stored and signed but never authorized for broadcast ('queued': a crash
// or a failed write between the store and the authority check) is resumed by the next register()
// or transfer() call for its key: the authority check runs, the row is claimed queued → submitted
// and exactly the stored signed operation is broadcast, once. Nothing is prepared or signed again.
// PGlite and a scripted chain (no network, no Anvil).

const network = baseNetwork(BASE_SEPOLIA)!;
const AGENT = 'agent-1';
const ID = 9n;
const URI = 'https://centralcity.ai/a/abc123';
const HEAD = 5000n;

async function setup(t: TestContext, walletState: 'derived' | 'frozen' = 'derived') {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  for (const sql of [
    BASE_MIGRATION_SQL,
    BASE_PAYMENTS_MIGRATION_SQL,
    baseShortIdsMigration.sql,
    BASE_SHARED_ADDITIONS_SQL,
    BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  ])
    await pg.exec(sql);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };

  const keyStore = pgSpenderKeyStore(db);
  const keystore = createKeystore({
    store: keyStore,
    keks: parseKeks(`v1:${randomBytes(32).toString('base64')}`),
  });
  const { spender, keyRef } = await createWalletChainPort({ keystore }).createSpender(BASE_SEPOLIA);
  const agentWallet = `0x${'7'.repeat(40)}` as Address;
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1',$5,'ws-1',84532,$1,$2,$3,$4,'{}',$6,0,0)`,
    [agentWallet, `0x${'2'.repeat(40)}`, spender, keyRef, AGENT, walletState],
  );

  // Every chain read is recorded; the account's next nonce never moves (nothing landed).
  const reads: string[] = [];
  let stuckNonce = 0n;
  const client = {
    getBlockNumber: async () => (reads.push('getBlockNumber'), HEAD),
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint } = {}) => {
      reads.push(`getBlock:${args.blockTag ?? args.blockNumber}`);
      return { number: HEAD, hash: `0x${'0e'.repeat(32)}` };
    },
    readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      reads.push(`readContract:${args.functionName}`);
      if (args.functionName === 'getNonce') return stuckNonce;
      throw new Error(`unexpected read ${args.functionName}`);
    },
    getCode: async () => {
      reads.push('getCode');
      throw new Error('a resumed operation is never rebuilt');
    },
    getLogs: async () => (reads.push('getLogs'), []),
    getTransactionReceipt: async () => {
      reads.push('getTransactionReceipt');
      throw new Error('nothing landed');
    },
  } as unknown as PublicClient;

  const sent: UserOperation<'0.6'>[] = [];
  let prepares = 0;
  const bundler: Bundler = {
    prepare: async () => {
      prepares++;
      throw new Error('a resumed operation is never prepared again');
    },
    send: async (op) => {
      sent.push(op);
      return `0x${'99'.repeat(32)}`;
    },
    // The bundler has no receipt: the operation is still waiting for its block.
    receipt: async () => null,
  };
  let signs = 0;
  const operations = pgChainOperationStore(db);
  const port = createIdentityChainPort({
    network,
    client,
    db,
    operations,
    bundler,
    keystore: {
      withSigner: (ref, use) => (signs++, keystore.withSigner(ref, use)),
    },
    signerOf: async (ref) => (await keyStore.get(parseKeyRef(ref).keyId))!.signerAddress,
  });

  /** Stores a signed operation for `key` exactly as submitOperation stores it before broadcast. */
  const store = async (
    key: string,
    row: Pick<StoredOperation, 'kind' | 'intentHash'> & {
      status?: StoredOperation['status'];
      nonce: bigint;
      signature: Hex;
      userOpHash: Hex;
    },
  ) => {
    const op = {
      sender: spender,
      nonce: row.nonce.toString(10),
      initCode: '0x',
      callData: `0xb61d27f6${row.signature.slice(2)}`,
      callGasLimit: '100000',
      verificationGasLimit: '200000',
      preVerificationGas: '50000',
      maxFeePerGas: '1000000',
      maxPriorityFeePerGas: '1000',
      paymasterAndData: '0x',
      signature: row.signature,
    };
    stuckNonce = row.nonce;
    return operations.insert({
      idempotencyKey: key,
      intentHash: row.intentHash,
      chainId: BASE_SEPOLIA,
      kind: row.kind,
      sender: spender,
      signer: spender,
      nonce: row.nonce.toString(10),
      userOpHash: row.userOpHash,
      signedOperation: JSON.stringify(op),
      status: row.status ?? 'queued',
      txHash: null,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      maxCostWei: '0',
      submittedBlock: (HEAD - 10n).toString(10),
      errorCode: null,
    });
  };

  return {
    db,
    port,
    spender,
    keyRef,
    agentWallet,
    store,
    operations,
    sent,
    reads,
    counts: () => ({ sends: sent.length, prepares, signs }),
  };
}

const nonceOn = (key: string, n = 0n) => (identityNonceLane(key) << 64n) | n;

test('queued hand-over: transfer() resumes it once with the stored signed operation', async (t) => {
  const s = await setup(t);
  const key = handoverKey(AGENT, BASE_SEPOLIA, ID);
  const stored = await s.store(key, {
    kind: 'transfer',
    intentHash: transferIntentHash(BASE_SEPOLIA, s.spender, ID, s.agentWallet),
    nonce: nonceOn(key),
    signature: `0x${'51'.repeat(65)}`,
    userOpHash: `0x${'a1'.repeat(32)}`,
  });
  assert.equal(stored.status, 'queued');
  const input = {
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: s.keyRef,
    spender: s.spender,
    id: ID,
    to: s.agentWallet,
  } as const;

  const first = await s.port.transfer(input);
  assert.equal(first.idempotencyKey, key);
  assert.equal(first.status, 'submitted', 'the queued hand-over left queued');
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 }, 'sent once, never re-signed');
  assert.deepEqual(s.sent[0], fromJson(stored.signedOperation), 'exactly the stored operation');
  assert.ok(!s.reads.includes('readContract:ownerOf'), 'a stored hand-over is never re-checked');
  assert.equal((await s.operations.get(key))!.status, 'submitted');

  // Asked again (the service polls): it is only reconciled; nothing is broadcast or signed again.
  const again = await s.port.transfer(input);
  assert.equal(again.status, 'submitted');
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 });
  const row = (await s.operations.get(key))!;
  assert.equal(row.status, 'submitted');
  assert.equal(row.signedOperation, stored.signedOperation, 'the stored operation never changes');
});

test('queued registration: register() resumes it once with the stored signed operation', async (t) => {
  const s = await setup(t);
  const key = registerKey(AGENT, BASE_SEPOLIA);
  const stored = await s.store(key, {
    kind: 'register',
    intentHash: registerIntentHash(BASE_SEPOLIA, s.spender, URI),
    nonce: nonceOn(key),
    signature: `0x${'52'.repeat(65)}`,
    userOpHash: `0x${'a2'.repeat(32)}`,
  });
  const input = {
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: s.keyRef,
    spender: s.spender,
    uri: URI,
  } as const;

  const first = await s.port.register(input);
  assert.equal(first.status, 'submitted', 'the queued registration left queued');
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 });
  assert.deepEqual(s.sent[0], fromJson(stored.signedOperation));

  const again = await s.port.register(input);
  assert.equal(again.status, 'submitted');
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 });
});

test('queued hand-over: a wallet frozen meanwhile is refused at resume and never sent', async (t) => {
  const s = await setup(t, 'frozen');
  const key = handoverKey(AGENT, BASE_SEPOLIA, ID);
  await s.store(key, {
    kind: 'transfer',
    intentHash: transferIntentHash(BASE_SEPOLIA, s.spender, ID, s.agentWallet),
    nonce: nonceOn(key),
    signature: `0x${'53'.repeat(65)}`,
    userOpHash: `0x${'a3'.repeat(32)}`,
  });
  const op = await s.port.transfer({
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: s.keyRef,
    spender: s.spender,
    id: ID,
    to: s.agentWallet,
  });
  assert.equal(op.status, 'failed');
  assert.deepEqual(s.counts(), { sends: 0, prepares: 0, signs: 0 });
  const row = (await s.operations.get(key))!;
  assert.equal(row.status, 'failed');
  assert.equal(row.errorCode, 'REFUSED_BEFORE_BROADCAST');
});

test('queued later attempt: resumed on its pinned nonce while the earlier attempt is pending', async (t) => {
  const s = await setup(t);
  const firstKey = handoverKey(AGENT, BASE_SEPOLIA, ID);
  const key = handoverKey(AGENT, BASE_SEPOLIA, ID, 1);
  const intentHash = transferIntentHash(BASE_SEPOLIA, s.spender, ID, s.agentWallet);
  // Attempt 0 was sent and is still waiting for its block; attempt 1 replaced it on the same
  // nonce (pinned) and was stored, but never authorized.
  const nonce = nonceOn(firstKey);
  await s.store(firstKey, {
    kind: 'transfer',
    intentHash,
    nonce,
    status: 'submitted',
    signature: `0x${'54'.repeat(65)}`,
    userOpHash: `0x${'a4'.repeat(32)}`,
  });
  const stored = await s.store(key, {
    kind: 'transfer',
    intentHash,
    nonce,
    signature: `0x${'55'.repeat(65)}`,
    userOpHash: `0x${'a5'.repeat(32)}`,
  });
  const input = {
    operationKey: key,
    chainId: BASE_SEPOLIA,
    spenderKeyRef: s.keyRef,
    spender: s.spender,
    id: ID,
    to: s.agentWallet,
  } as const;

  const op = await s.port.transfer(input);
  assert.equal(op.idempotencyKey, key);
  assert.equal(op.status, 'submitted');
  // Only attempt 1's stored operation is broadcast (attempt 0 is not due for a rebroadcast yet).
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 });
  assert.deepEqual(s.sent[0], fromJson(stored.signedOperation));

  await s.port.transfer(input);
  assert.deepEqual(s.counts(), { sends: 1, prepares: 0, signs: 0 });
});
