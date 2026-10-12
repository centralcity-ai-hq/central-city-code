import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { Hex, PublicClient } from 'viem';
import { postgresDatabase, type Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
} from '../server/base/schema.js';
import { pgChainOperationStore } from '../server/base/chain/stores.js';
import {
  REBROADCAST_MIN_MS,
  refreshFinality,
  type Bundler,
  type ChainOperationStore,
  type StoredOperation,
} from '../server/base/chain/submit.js';
import { BASE_SEPOLIA, baseNetwork, type Address } from '../shared/base/chains.js';

/*
 * The rebroadcast bound under concurrency (submit.ts REBROADCAST_MIN_MS, claimSend): readers
 * racing on the same stored operation (owner polls on several instances, the crons) each read the
 * same updated_at; the send is claimed before it is made, so exactly one of them sends per window.
 * On PGlite (one connection, statements serialize) and, with CITY_TEST_POSTGRES_URL set (CI:
 * postgres-races), on a real PostgreSQL pool where every reader has its own session. Synthetic
 * values only.
 */

const network = baseNetwork(BASE_SEPOLIA)!;
const POSTGRES = process.env.CITY_TEST_POSTGRES_URL;
const T0 = 1_760_000_000_000;
const KEY = 'op:race';
const OP_HASH = `0x${'aa'.repeat(32)}` as Hex;

const signed = JSON.stringify({
  sender: '0x1111111111111111111111111111111111111111',
  nonce: '5',
  initCode: '0x',
  callData: '0x',
  callGasLimit: '1',
  verificationGasLimit: '1',
  preVerificationGas: '1',
  maxFeePerGas: '1',
  maxPriorityFeePerGas: '1',
  paymasterAndData: '0x',
  signature: '0x',
});

const operation = (): StoredOperation => ({
  idempotencyKey: KEY,
  intentHash: `0x${'11'.repeat(32)}`,
  chainId: BASE_SEPOLIA,
  kind: 'transfer',
  sender: '0x1111111111111111111111111111111111111111',
  signer: '0x2222222222222222222222222222222222222222',
  nonce: '5',
  userOpHash: OP_HASH,
  signedOperation: signed,
  status: 'queued',
  txHash: null,
  blockNumber: null,
  gasUsed: null,
  feeWei: null,
  maxCostWei: '0',
  submittedBlock: '1000',
  errorCode: null,
});

/** A node where the operation has not landed (its nonce is still ours) and nothing is logged. */
const client = {
  getBlockNumber: async () => 2000n,
  getBlock: async () => ({ number: 1997n, hash: `0x${'bb'.repeat(32)}` }),
  readContract: async () => 5n,
  getLogs: async () => [],
} as unknown as PublicClient;

/**
 * A bundler with no receipt yet. Every receipt lookup waits until `readers` lookups are waiting,
 * so all readers hold the same snapshot of the row before any of them decides to send.
 */
function racingBundler(readers: number, failSends = false) {
  let waiting = 0;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const sends: number[] = [];
  const bundler: Bundler = {
    prepare: async (op) => op,
    send: async () => {
      sends.push(sends.length);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (failSends) throw new Error('bundler unreachable');
      return OP_HASH;
    },
    receipt: async () => {
      if (++waiting >= readers) open();
      await gate;
      return null;
    },
  };
  return { bundler, sends };
}

const deps = (store: ChainOperationStore, bundler: Bundler, now: number) => ({
  network,
  client,
  store,
  bundler,
  now: () => now,
  signer: {
    address: '0x2222222222222222222222222222222222222222' as Address,
    signUserOperation: async (): Promise<Hex> => '0x',
  },
});

/** The operation stored and claimed for its first send at T0 ('submitted', updated_at T0). */
async function sentAtT0(db: Database) {
  const store = pgChainOperationStore(db, () => T0);
  await store.insert(operation());
  assert.ok(await store.transition(KEY, ['queued'], { status: 'submitted' }));
  return store;
}

async function pglite(t: TestContext): Promise<Database> {
  const lite = await PGlite.create('memory://');
  t.after(() => lite.close());
  await lite.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await lite.exec(BASE_MIGRATION_SQL);
  await lite.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await lite.exec(BASE_SHARED_ADDITIONS_SQL);
  return {
    query: (sql, params) => lite.query(sql, params) as never,
    exec: (sql) => lite.exec(sql),
    transaction: (action) => lite.transaction((tx) => action(tx as never)),
    close: () => lite.close(),
  };
}

async function postgres(t: TestContext): Promise<Database> {
  const name = `city_rebroadcast_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(POSTGRES!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 30 });
  pool.on('error', () => {});
  const db = postgresDatabase(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  await db.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await db.exec(BASE_MIGRATION_SQL);
  await db.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await db.exec(BASE_SHARED_ADDITIONS_SQL);
  return db;
}

/** `readers` refreshes of the same operation at once, each with its own store (an instance). */
async function race(db: Database, readers: number, at: number, failSends = false) {
  const { bundler, sends } = racingBundler(readers, failSends);
  const rows = await Promise.all(
    Array.from({ length: readers }, () =>
      refreshFinality(
        deps(
          pgChainOperationStore(db, () => at),
          bundler,
          at,
        ),
        KEY,
      ),
    ),
  );
  return { sends: sends.length, rows };
}

async function exactlyOnePerWindow(db: Database, readers: number) {
  await sentAtT0(db);
  // Within the window: nobody sends.
  assert.equal((await race(db, readers, T0 + REBROADCAST_MIN_MS - 1)).sends, 0);
  // The window is over and every reader holds the same updated_at: exactly one sends.
  const first = await race(db, readers, T0 + REBROADCAST_MIN_MS);
  assert.equal(first.sends, 1, 'one eth_sendUserOperation between all readers');
  for (const row of first.rows) assert.equal(row?.status, 'submitted');
  // Right after it, all of them again: the window restarted at that send.
  assert.equal((await race(db, readers, T0 + REBROADCAST_MIN_MS + 2_500)).sends, 0);
  assert.equal((await race(db, readers, T0 + 2 * REBROADCAST_MIN_MS)).sends, 1);
}

test('two readers racing on the same updated_at send once (PGlite)', async (t) => {
  await exactlyOnePerWindow(await pglite(t), 2);
});

test('a claimed resend that fails leaves the operation submitted; the next window sends again', async (t) => {
  const db = await pglite(t);
  const store = await sentAtT0(db);
  const failed = await race(db, 2, T0 + REBROADCAST_MIN_MS, true);
  assert.equal(failed.sends, 1);
  const after = (await store.get(KEY))!;
  assert.equal(after.status, 'submitted', 'not marked ambiguous: the bundler took it before');
  assert.equal(after.errorCode, null);
  assert.equal(after.updatedAt, T0 + REBROADCAST_MIN_MS, 'the claim is the window’s send');
  // Within that window nothing more; the next window sends again.
  assert.equal((await race(db, 2, T0 + REBROADCAST_MIN_MS + 10_000)).sends, 0);
  assert.equal((await race(db, 2, T0 + 2 * REBROADCAST_MIN_MS)).sends, 1);
});

test('sends never held back are not doubled by racing readers either', async (t) => {
  const db = await pglite(t);
  const store = await sentAtT0(db);
  // A dropped block ('reorged', just written): resent at once, by one of the racing readers.
  assert.ok(
    await store.transition(KEY, ['submitted'], { status: 'reorged', errorCode: 'RECEIPT_GONE' }),
  );
  const resent = await race(db, 3, T0 + 1);
  assert.equal(resent.sends, 1);
  assert.equal((await store.get(KEY))?.status, 'submitted');
  // A send that failed ('unknown'), read by racing readers whose clock is behind the row's: still
  // resent at once, by one of them, and the write time moves forward, never back.
  assert.ok(
    await store.transition(KEY, ['submitted'], {
      status: 'unknown',
      errorCode: 'BROADCAST_AMBIGUOUS',
    }),
  );
  const before = (await store.get(KEY))!.updatedAt!;
  const behind = await race(db, 3, before - 60_000);
  assert.equal(behind.sends, 1);
  assert.equal((await store.get(KEY))?.status, 'submitted');
  assert.ok((await store.get(KEY))!.updatedAt! >= before);
});

test('a submitted row read by clocks behind it: no send until updated_at + the window', async (t) => {
  const db = await pglite(t);
  await sentAtT0(db);
  // Two sequential rounds of fresh reads at a fixed time behind the stored timestamp: no send.
  assert.equal((await race(db, 3, T0 - 60_000)).sends, 0);
  assert.equal((await race(db, 3, T0 - 60_000)).sends, 0);
  assert.equal((await race(db, 3, T0 + REBROADCAST_MIN_MS - 1)).sends, 0);
  // Past updated_at + the window: exactly one between them.
  assert.equal((await race(db, 3, T0 + REBROADCAST_MIN_MS)).sends, 1);
  assert.equal((await race(db, 3, T0 - 60_000)).sends, 0, 'a clock behind again sends nothing');
});

test('the claim is one compare-and-set: a stale snapshot or another status never claims', async (t) => {
  const db = await pglite(t);
  const store = await sentAtT0(db);
  assert.equal(await store.claimSend!(KEY, 'submitted', T0 - 1, T0 + 60_000), null);
  assert.equal(await store.claimSend!(KEY, 'unknown', T0, T0 + 60_000), null);
  const won = await store.claimSend!(KEY, 'submitted', T0, T0 + 60_000);
  assert.equal(won?.updatedAt, T0 + 60_000);
  assert.equal(won?.status, 'submitted');
  assert.equal(await store.claimSend!(KEY, 'submitted', T0, T0 + 60_000), null, 'once only');
});

test(
  'ten readers on separate PostgreSQL sessions send once per window',
  { skip: !POSTGRES },
  async (t) => {
    await exactlyOnePerWindow(await postgres(t), 10);
  },
);
