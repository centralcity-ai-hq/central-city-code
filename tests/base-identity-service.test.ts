import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_IDENTITY_PROVISIONAL_SQL,
  BASE_IDENTITY_HANDOVER_BACKOFF_SQL,
  BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  baseShortIdsMigration,
} from '../server/base/schema.js';
import {
  createIdentityService,
  registerKey,
  transferKey,
  type IdentityChainPort,
  type IdentityOp,
} from '../server/base/identity/service.js';
import { BASE_SEPOLIA } from '../shared/base/chains.js';

const WALLET = `0x${'1'.repeat(40)}`;
const SPENDER = `0x${'3'.repeat(40)}`;

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(baseShortIdsMigration.sql);
  await pg.exec(BASE_IDENTITY_PROVISIONAL_SQL);
  await pg.exec(BASE_IDENTITY_HANDOVER_BACKOFF_SQL);
  await pg.exec(BASE_SEARCH_CURSOR_REGISTER_BACKOFF_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  await db.query(
    `INSERT INTO base_wallets VALUES ('w1','a1','ws',$1,$2,'0x${'2'.repeat(40)}',$3,'v1:k','{}',
      'derived',1,1)`,
    [BASE_SEPOLIA, WALLET, SPENDER],
  );
  return db;
}

/** A chain whose operations finish after a set number of polls. */
function fakeChain(polls: { register: number; transfer: number }, fail?: 'register' | 'transfer') {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const step = (key: string, kind: 'register' | 'transfer'): IdentityOp => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const done = n > polls[kind];
    return {
      idempotencyKey: key,
      status: done ? (fail === kind ? 'failed' : 'final') : 'submitted',
      txHash: done ? `0x${kind === 'register' ? 'a' : 'b'}` : null,
    };
  };
  const chain: IdentityChainPort = {
    async register(input) {
      calls.push(`register ${input.uri} from ${input.spender}`);
      return step(input.operationKey, 'register');
    },
    async registeredId() {
      return 4711n;
    },
    async transfer(input) {
      calls.push(`transfer ${input.id} to ${input.to}`);
      return step(input.operationKey, 'transfer');
    },
  };
  return { chain, calls, seen };
}

test('register, then hand over to the agent wallet; retries reuse the same operations', async (t) => {
  const db = await setup(t);
  const { chain, seen } = fakeChain({ register: 1, transfer: 1 });
  const svc = createIdentityService({ db, chain, now: () => 5 });

  const first = await svc.advance('a1', BASE_SEPOLIA);
  assert.equal(first.state, 'submitted');
  assert.equal(first.erc8004AgentId, null);
  assert.match(first.agentUri, /^https:\/\/centralcity\.ai\/a\/[0-9A-Za-z]{6}$/);

  const second = await svc.advance('a1', BASE_SEPOLIA); // registration final; transfer sent
  assert.equal(second.state, 'submitted');
  assert.equal(second.erc8004AgentId, '4711');

  const third = await svc.advance('a1', BASE_SEPOLIA);
  assert.equal(third.state, 'confirmed');
  const { rows } = await db.query<{ owner_of_identity: string }>(
    `SELECT owner_of_identity FROM base_identities WHERE agent_id = 'a1'`,
  );
  assert.equal(rows[0].owner_of_identity, WALLET);

  // Confirmed is final: no further chain calls.
  const calls = [...seen.entries()];
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'confirmed');
  assert.deepEqual([...seen.entries()], calls);
  assert.deepEqual(
    [...seen.keys()],
    [registerKey('a1', BASE_SEPOLIA), transferKey('a1', BASE_SEPOLIA)],
  );
});

test('a failed operation ends in failed, never in a new attempt', async (t) => {
  const db = await setup(t);
  const { chain, calls } = fakeChain({ register: 0, transfer: 0 }, 'transfer');
  const svc = createIdentityService({ db, chain });
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'failed');
  const before = calls.length;
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'failed');
  assert.equal(calls.length, before);
});

test('no wallet, frozen wallet or unavailable network are refused', async (t) => {
  const db = await setup(t);
  const { chain } = fakeChain({ register: 0, transfer: 0 });
  const svc = createIdentityService({ db, chain });
  await assert.rejects(svc.advance('nobody', BASE_SEPOLIA), /no wallet/);
  await assert.rejects(svc.advance('a1', 8453), /not available/);
  await db.query(`UPDATE base_wallets SET state = 'frozen'`);
  await assert.rejects(svc.advance('a1', BASE_SEPOLIA), /frozen/);
});

test('after a failed registration the owner retries with a new operation key', async (t) => {
  const db = await setup(t);
  const keys: string[] = [];
  let failNext = true;
  const chain: IdentityChainPort = {
    async register(input) {
      keys.push(input.operationKey);
      const status = failNext ? 'failed' : 'final';
      failNext = false;
      return { idempotencyKey: input.operationKey, status, txHash: '0xa' };
    },
    async registeredId() {
      return 9n;
    },
    async transfer(input) {
      keys.push(input.operationKey);
      return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xb' };
    },
  };
  const svc = createIdentityService({ db, chain });
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'failed');
  // Without an explicit retry nothing is sent again.
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'failed');
  assert.equal(keys.length, 1);
  const retried = await svc.advance('a1', BASE_SEPOLIA, { retry: true });
  assert.equal(retried.state, 'confirmed');
  assert.equal(retried.erc8004AgentId, '9');
  assert.deepEqual(keys, [
    registerKey('a1', BASE_SEPOLIA),
    registerKey('a1', BASE_SEPOLIA, 1),
    transferKey('a1', BASE_SEPOLIA),
  ]);
  assert.equal('opId' in retried, false);
});

test('a registration stuck before minting can be retried after 10 minutes, not before', async (t) => {
  const db = await setup(t);
  const keys: string[] = [];
  let clock = 1_000;
  let stuck = true;
  const chain: IdentityChainPort = {
    async register(input) {
      keys.push(input.operationKey);
      return {
        idempotencyKey: input.operationKey,
        status: stuck ? 'unknown' : 'final',
        txHash: stuck ? null : '0xa',
      };
    },
    async registeredId() {
      return 5n;
    },
    async transfer(input) {
      return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xb' };
    },
  };
  const svc = createIdentityService({ db, chain, now: () => clock });
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'submitted');
  // Polling every few seconds does not reset the waiting time.
  for (let i = 0; i < 12; i++) {
    clock += 5_000;
    await svc.advance('a1', BASE_SEPOLIA);
  }
  await svc.advance('a1', BASE_SEPOLIA, { retry: true }); // too early: same key again
  assert.ok(keys.every((key) => key === registerKey('a1', BASE_SEPOLIA)));
  clock += 9 * 60_000;
  stuck = false;
  const done = await svc.advance('a1', BASE_SEPOLIA, { retry: true });
  assert.equal(keys.at(-1), registerKey('a1', BASE_SEPOLIA, 1));
  assert.equal(done.state, 'confirmed');
});

for (const staleStatus of ['failed', 'submitted', 'final'] as const) {
  test(`late old ${staleStatus} cannot erase a newer retry attempt`, async (t) => {
    const db = await setup(t);
    let clock = 1000;
    let initial = true;
    let oldStarted!: () => void;
    let newStarted!: () => void;
    let finishOld!: (op: IdentityOp) => void;
    let finishNew!: (op: IdentityOp) => void;
    const oldReady = new Promise<void>((r) => {
      oldStarted = r;
    });
    const newReady = new Promise<void>((r) => {
      newStarted = r;
    });
    const oldResult = new Promise<IdentityOp>((r) => {
      finishOld = r;
    });
    const newResult = new Promise<IdentityOp>((r) => {
      finishNew = r;
    });
    const firstKey = registerKey('a1', BASE_SEPOLIA);
    const nextKey = registerKey('a1', BASE_SEPOLIA, 1);
    const chain: IdentityChainPort = {
      async register(input) {
        if (initial) {
          initial = false;
          return { idempotencyKey: firstKey, status: 'unknown', txHash: null };
        }
        if (input.operationKey === firstKey) {
          oldStarted();
          return oldResult;
        }
        assert.equal(input.operationKey, nextKey);
        newStarted();
        return newResult;
      },
      async registeredId() {
        return 9n;
      },
      async transfer(input) {
        return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xb' };
      },
    };
    const svc = createIdentityService({ db, chain, now: () => clock });
    await svc.advance('a1', BASE_SEPOLIA);
    clock += 600001;
    const old = svc.advance('a1', BASE_SEPOLIA);
    await oldReady;
    const retry = svc.advance('a1', BASE_SEPOLIA, { retry: true });
    await newReady;
    finishOld({ idempotencyKey: firstKey, status: staleStatus, txHash: null });
    const oldOutcome = await old.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const afterOld = await db.query<{ op_id: string }>(
      "SELECT op_id FROM base_identities WHERE agent_id = 'a1'",
    );
    // Keep the new attempt pending to isolate the stale write before later chain work.
    finishNew({ idempotencyKey: nextKey, status: 'submitted', txHash: null });
    const result = await retry;
    assert.equal(
      oldOutcome.error,
      null,
      'stale completion must return current state without throwing',
    );
    assert.equal(afterOld.rows[0].op_id, nextKey, 'stale callback must not replace the active key');
    assert.equal(result.state, 'submitted');
    const row = await db.query<{ op_id: string }>(
      "SELECT op_id FROM base_identities WHERE agent_id = 'a1'",
    );
    assert.equal(row.rows[0].op_id, nextKey);
  });
}

test('an earlier attempt reported by the chain never moves the row back to its number', async (t) => {
  const db = await setup(t);
  const keys: string[] = [];
  const idsReadFrom: string[] = [];
  let calls = 0;
  const chain: IdentityChainPort = {
    async register(input) {
      keys.push(input.operationKey);
      calls++;
      // Attempt 0 fails; attempt 1 reports attempt 0 (an earlier attempt of the step, e.g. its
      // nonce's outcome); attempt 2 finds that attempt 0 landed after all.
      const earlier = registerKey('a1', BASE_SEPOLIA);
      if (calls === 1) return { idempotencyKey: earlier, status: 'failed', txHash: null };
      if (calls === 2) return { idempotencyKey: earlier, status: 'failed', txHash: null };
      return { idempotencyKey: earlier, status: 'final', txHash: '0xa' };
    },
    async registeredId(op) {
      idsReadFrom.push(op.idempotencyKey);
      return 12n;
    },
    async transfer(input) {
      keys.push(input.operationKey);
      return { idempotencyKey: input.operationKey, status: 'final', txHash: '0xb' };
    },
  };
  const svc = createIdentityService({ db, chain });
  assert.equal((await svc.advance('a1', BASE_SEPOLIA)).state, 'failed');
  assert.equal((await svc.advance('a1', BASE_SEPOLIA, { retry: true })).state, 'failed');
  const { rows } = await db.query<{ op_id: string }>(
    `SELECT op_id FROM base_identities WHERE agent_id = 'a1'`,
  );
  assert.equal(rows[0].op_id, registerKey('a1', BASE_SEPOLIA, 1), 'stays on attempt 1');
  const done = await svc.advance('a1', BASE_SEPOLIA, { retry: true });
  assert.equal(done.state, 'confirmed');
  assert.deepEqual(keys, [
    registerKey('a1', BASE_SEPOLIA),
    registerKey('a1', BASE_SEPOLIA, 1),
    registerKey('a1', BASE_SEPOLIA, 2),
    transferKey('a1', BASE_SEPOLIA),
  ]);
  // The minted id is read from the attempt that actually landed.
  assert.deepEqual(idsReadFrom, [registerKey('a1', BASE_SEPOLIA)]);
});
