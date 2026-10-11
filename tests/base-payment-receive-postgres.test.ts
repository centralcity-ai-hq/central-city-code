import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import {
  createReceiveStore,
  RECEIVE_RECONCILE_SQL,
  RECEIVE_SQL,
} from '../server/base/payments/receive-store.js';
import { createReceiveRuntime } from '../server/base/payments/receive-runtime.js';

test(
  'real PG: two independent receive claims settle exactly once',
  { skip: !process.env.CITY_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const url = process.env.CITY_TEST_POSTGRES_URL!;
    const name = `city_receive_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const pools: pg.Pool[] = [];
    let created = false;
    t.after(async () => {
      try {
        await Promise.all(pools.map((pool) => pool.end()));
        if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const isolated = new URL(url);
    isolated.pathname = `/${name}`;
    for (let i = 0; i < 2; i++)
      pools.push(
        new pg.Pool({
          connectionString: isolated.toString(),
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 10000,
          lock_timeout: 8000,
        }),
      );
    const dbs = pools.map(postgresDatabase);
    await dbs[0].exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES('one')",
    );
    await dbs[0].exec(RECEIVE_SQL);
    await dbs[0].exec(RECEIVE_RECONCILE_SQL);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pids = new Set<number>();
    const stores = dbs.map((db) =>
      createReceiveStore({
        ...db,
        transaction: ((action) =>
          db.transaction(async (tx) => {
            pids.add(
              (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid,
            );
            if (++arrivals === 2) release();
            await barrier;
            return action(tx);
          })) as Database['transaction'],
      }),
    );
    const binding = {
      workspaceId: 'one',
      resource: 'resource',
      chainId: 84532,
      token: `0x${'1'.repeat(40)}`,
      payer: `0x${'2'.repeat(40)}`,
      recipient: `0x${'3'.repeat(40)}`,
      nonce: `0x${'4'.repeat(64)}`,
      amount: '10',
    };
    let settlements = 0;
    let deliveries = 0;
    const hash = `0x${'5'.repeat(64)}` as const;
    const results = await Promise.all(
      stores.map((store) =>
        createReceiveRuntime({
          store,
          evidence: async () => null,
          deliver: async () => {
            deliveries++;
          },
        })(binding, async () => {
          settlements++;
          return { kind: 'settled', transaction: hash };
        }),
      ),
    );
    assert.equal(pids.size, 2);
    assert.equal(settlements, 1);
    assert.equal(deliveries, 0);
    assert.ok(results.every((result) => result.kind === 'pending'));
    assert.equal(results[0].receiptId, results[1].receiptId);
    const rows = (await dbs[0].query('SELECT state,transaction_hash FROM base_x402_receipts')).rows;
    assert.deepEqual(rows, [{ state: 'reconciling', transaction_hash: hash }]);
  },
);
