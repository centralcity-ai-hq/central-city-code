import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { PublicClient } from 'viem';
import type { Database } from '../server/database.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_FLEET_MIGRATION_SQL,
} from '../server/base/schema.js';
import { admitFleetRun, type FleetAdmission } from '../server/base/fleet/admit.js';
import { BASE_SEPOLIA, NATIVE_ETH, baseNetwork } from '../shared/base/chains.js';
import { manifestHash } from '../shared/base/manifest.js';

const network = baseNetwork(BASE_SEPOLIA)!;
const address = `0x${'1'.repeat(40)}` as const;
const owner = `0x${'2'.repeat(40)}` as const;
const agent = '00000000-0000-0000-0000-000000000001';
const manifest = [{ ordinal: 0, agentId: agent, wallet: address, owner, derivationVersion: 1 }];
function request(): FleetAdmission {
  return {
    workspaceId: 'w',
    jobId: 'j',
    treasuryWalletId: 'wallet',
    signature: '0x00',
    manifest,
    registrationMode: 'lazy',
    providerPricing: 'v1:0:0',
    intent: {
      workspaceId: 'w',
      chainId: BASE_SEPOLIA,
      treasury: address,
      manifestHash: manifestHash(manifest),
      principal: [
        { token: NATIVE_ETH, amount: 100n },
        { token: network.tokens.USDC.address, amount: 100n },
      ],
      feeCeilingWei: 20n,
      nonce: 1n,
      notBefore: 1,
      expiry: 10,
    },
    batch: {
      operationKey: 'op',
      intentHash: 'batch-hash',
      principal: [
        { token: NATIVE_ETH, amount: 10n },
        { token: network.tokens.USDC.address, amount: 10n },
      ],
      maxCostWei: 5n,
    },
  };
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec("CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES('w')");
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_FLEET_MIGRATION_SQL);
  await pg.query(
    `INSERT INTO base_wallets VALUES('wallet',$1,'w',84532,$2,$3,$3,'v1:key','{"version":1}','derived',1,1)`,
    [agent, address, owner],
  );
  let time = 2000;
  let valid = true;
  let balanceReads = 0;
  let balance = async (_token: string) => 100n;
  const db = {
    query: pg.query.bind(pg),
    exec: pg.exec.bind(pg),
    transaction: (fn: any) => pg.transaction(fn),
    close: () => pg.close(),
  } as Database;
  const deps = {
    db,
    network,
    now: () => time,
    client: {
      getChainId: async () => BASE_SEPOLIA,
      verifyHash: async () => valid,
    } as unknown as PublicClient,
    balanceOf: async (_address: string, token: string) => {
      balanceReads++;
      return { balance: await balance(token), blockNumber: 1n };
    },
  };
  const empty = async () => {
    for (const table of [
      'base_fleet_jobs',
      'base_fleet_batches',
      'base_fleet_token_budgets',
      'base_fleet_fee_budgets',
      'base_fleet_batch_allocations',
      'base_wallet_reservations',
    ])
      assert.equal((await pg.query(`SELECT * FROM ${table}`)).rows.length, 0, table);
  };
  return {
    pg,
    deps,
    empty,
    setTime: (n: number) => {
      time = n;
    },
    setValid: (v: boolean) => {
      valid = v;
    },
    setBalance: (f: typeof balance) => {
      balance = f;
    },
    reads: () => balanceReads,
  };
}
test('admission commits principal and fees together; nonce replay cannot duplicate', async (t) => {
  const f = await setup(t);
  const result = await admitFleetRun(f.deps, request());
  assert.equal(result.feeHeld, 5n);
  assert.equal((await f.pg.query('SELECT * FROM base_wallet_reservations')).rows.length, 2);
  assert.deepEqual(
    (await f.pg.query('SELECT reserved_wei::text FROM base_fleet_fee_budgets')).rows,
    [{ reserved_wei: '5' }],
  );
  await assert.rejects(admitFleetRun(f.deps, { ...request(), jobId: 'other' }), /nonce/);
  assert.equal((await f.pg.query('SELECT * FROM base_fleet_jobs')).rows.length, 1);
});
test('partial principal funding and fee ceiling failures roll back job, nonce and all holds', async (t) => {
  const f = await setup(t);
  f.setBalance(async (token) => (token.toLowerCase() === NATIVE_ETH.toLowerCase() ? 100n : 0n));
  await assert.rejects(admitFleetRun(f.deps, request()), /Balance/);
  assert.equal(f.reads(), 2);
  await f.empty();
  f.setBalance(async () => 100n);
  const r = request();
  r.batch.maxCostWei = 21n;
  await assert.rejects(admitFleetRun(f.deps, r));
  await f.empty();
  await admitFleetRun(f.deps, request());
});
test('bad signatures and expiry during balance reads refuse without committed accounting', async (t) => {
  const f = await setup(t);
  f.setValid(false);
  await assert.rejects(admitFleetRun(f.deps, request()), /BAD_SIGNATURE/);
  assert.equal(f.reads(), 0);
  await f.empty();
  f.setValid(true);
  f.setBalance(async () => {
    f.setTime(10000);
    return 100n;
  });
  await assert.rejects(admitFleetRun(f.deps, request()), /admissible|window/);
  await f.empty();
  await assert.rejects(admitFleetRun(f.deps, request()), /EXPIRED/);
  await f.empty();
});
test('concurrent same-nonce admissions produce one durable job', async (t) => {
  const f = await setup(t);
  const r = request();
  const results = await Promise.allSettled([
    admitFleetRun(f.deps, r),
    admitFleetRun(f.deps, {
      ...request(),
      jobId: 'other',
      batch: { ...r.batch, operationKey: 'other-op' },
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await f.pg.query('SELECT * FROM base_fleet_jobs')).rows.length, 1);
  assert.equal((await f.pg.query('SELECT * FROM base_wallet_reservations')).rows.length, 2);
});

test('expiry while wallet locks wait and scope mismatches leave no accounting', async (t) => {
  const f = await setup(t);
  const transaction = f.deps.db.transaction.bind(f.deps.db);
  const delayed = {
    ...f.deps,
    db: {
      ...f.deps.db,
      transaction: ((fn: any) =>
        transaction(async (tx) =>
          fn({
            exec: tx.exec.bind(tx),
            query: async (sql: string, params?: unknown[]) => {
              const result = await tx.query(sql, params);
              if (sql.includes('ORDER BY wallet_id FOR UPDATE')) f.setTime(10000);
              return result;
            },
          }),
        )) as Database['transaction'],
    },
  };
  await assert.rejects(admitFleetRun(delayed, request()), /window/);
  await f.empty();
  f.setTime(2000);
  await assert.rejects(
    admitFleetRun(f.deps, { ...request(), workspaceId: 'foreign' }),
    /workspace/,
  );
  await f.empty();
  const wrong = request();
  wrong.intent.treasury = owner;
  await assert.rejects(admitFleetRun(f.deps, wrong), /treasury/);
  await f.empty();
});
test('caller mutations during signature verification cannot change persisted intent or allocations', async (t) => {
  const f = await setup(t);
  const r = request();
  const originalHash = manifestHash(r.manifest);
  f.deps.client = {
    getChainId: async () => BASE_SEPOLIA,
    verifyHash: async () => {
      r.intent.nonce = 9n;
      r.intent.feeCeilingWei = 900n;
      r.batch.principal[0].amount = 90n;
      r.batch.maxCostWei = 90n;
      return true;
    },
  } as unknown as PublicClient;
  await admitFleetRun(f.deps, r);
  assert.deepEqual((await f.pg.query('SELECT run_nonce,manifest_hash FROM base_fleet_jobs')).rows, [
    { run_nonce: '1', manifest_hash: originalHash },
  ]);
  assert.deepEqual(
    (await f.pg.query('SELECT ceiling_wei::text,reserved_wei::text FROM base_fleet_fee_budgets'))
      .rows,
    [{ ceiling_wei: '20', reserved_wei: '5' }],
  );
  assert.ok(
    (
      await f.pg.query<{ amount: string }>('SELECT amount::text FROM base_wallet_reservations')
    ).rows.every((r) => r.amount === '10'),
  );
});

test(
  'real PG: two sessions admitting the same nonce commit exactly one job',
  { skip: !process.env.CITY_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const { default: pg } = await import('pg');
    const { randomBytes } = await import('node:crypto');
    const { postgresDatabase } = await import('../server/database.js');
    const url = process.env.CITY_TEST_POSTGRES_URL!;
    const name = `city_fleet_admit_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    const isolated = new URL(url);
    isolated.pathname = `/${name}`;
    const pools = [0, 1].map(
      () =>
        new pg.Pool({
          connectionString: isolated.toString(),
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
          lock_timeout: 8000,
        }),
    );
    t.after(async () => {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    const dbs = pools.map(postgresDatabase);
    await dbs[0].exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES('w')",
    );
    await dbs[0].exec(BASE_MIGRATION_SQL);
    await dbs[0].exec(BASE_PAYMENTS_MIGRATION_SQL);
    await dbs[0].exec(BASE_FLEET_MIGRATION_SQL);
    await dbs[0].query(
      `INSERT INTO base_wallets VALUES('wallet',$1,'w',84532,$2,$3,$3,'v1:key','{"version":1}','derived',1,1)`,
      [agent, address, owner],
    );
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pids = new Set<number>();
    const concurrent = dbs.map((db) => ({
      ...db,
      transaction: ((fn: any) =>
        db.transaction(async (tx) => {
          const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
            .pid;
          pids.add(pid);
          if (++arrivals === 2) release();
          await barrier;
          return fn(tx);
        })) as Database['transaction'],
    }));
    const common = {
      network,
      now: () => 2000,
      client: {
        getChainId: async () => BASE_SEPOLIA,
        verifyHash: async () => true,
      } as unknown as PublicClient,
      balanceOf: async () => ({ balance: 100n, blockNumber: 1n }),
    };
    const results = await Promise.allSettled(
      concurrent.map((db, index) => {
        const r = request();
        r.jobId = `job-${index}`;
        r.batch.operationKey = `op-${index}`;
        return admitFleetRun({ ...common, db }, r);
      }),
    );
    assert.equal(pids.size, 2, 'must exercise two independent database sessions');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await dbs[0].query('SELECT * FROM base_fleet_jobs')).rows.length, 1);
    assert.equal((await dbs[0].query('SELECT * FROM base_wallet_reservations')).rows.length, 2);
    assert.equal((await dbs[0].query('SELECT * FROM base_fleet_batches')).rows.length, 1);
    t.diagnostic('two distinct backend sessions; exactly one durable admission');
  },
);

test('a separate frozen or closed treasury cannot admit; active treasury can', async (t) => {
  const f = await setup(t);
  const treasuryAddress = `0x${'3'.repeat(40)}` as const;
  await f.pg.query(
    `INSERT INTO base_wallets VALUES('treasury',$1,'w',84532,$2,$3,$3,'v1:treasury','{"version":1}','frozen',1,1)`,
    ['00000000-0000-0000-0000-000000000002', treasuryAddress, owner],
  );
  const r = request();
  r.treasuryWalletId = 'treasury';
  r.intent.treasury = treasuryAddress;
  for (const state of ['frozen', 'closed']) {
    await f.pg.query("UPDATE base_wallets SET state=$1 WHERE wallet_id='treasury'", [state]);
    await assert.rejects(admitFleetRun(f.deps, r), /treasury is not active/);
    assert.equal(f.reads(), 0);
    await f.empty();
  }
  await f.pg.query("UPDATE base_wallets SET state='deployed' WHERE wallet_id='treasury'");
  assert.equal((await admitFleetRun(f.deps, r)).feeHeld, 5n);
  assert.equal((await f.pg.query('SELECT * FROM base_wallet_reservations')).rows.length, 2);
});
