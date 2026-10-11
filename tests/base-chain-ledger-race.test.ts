import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } from '../server/base/schema.js';
import { createReservationLedger, ReservationError } from '../server/base/chain/reservations.js';
import type { Address } from '../shared/base/chains.js';

/**
 * The reservation ledger under real concurrency. PGlite has one connection, so its transactions
 * serialize; only a real PostgreSQL pool makes reserves race on separate sessions. Runs when
 * CITY_TEST_POSTGRES_URL points at a server whose role may create databases (CI: postgres-races).
 */
const POSTGRES = process.env.CITY_TEST_POSTGRES_URL;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

async function database(t: TestContext): Promise<Database> {
  const name = `city_ledger_${randomBytes(6).toString('hex')}`;
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
  await db.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$1,$1,'v1:k','{}','derived',0,0)`,
    ['0x1111111111111111111111111111111111111111'],
  );
  return db;
}

// A slow balance read widens the window between "read" and "insert", where an unlocked
// implementation would let several reserves see the same free balance.
const slowLedger = (balance: bigint) =>
  createReservationLedger({
    chainId: 84532,
    balanceOf: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { balance, blockNumber: 1_000n };
    },
  });

test(
  'concurrent reserves on separate sessions never hold more than the balance',
  { skip: !POSTGRES },
  async (t) => {
    const db = await database(t);
    const ledger = slowLedger(100n);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db
          .transaction((tx) =>
            ledger.reserve(tx, {
              walletId: 'w-1',
              chainId: 84532,
              token: USDC,
              amount: 10n,
              holder: { kind: 'payment', ref: `p-${i}` },
              intentHash: `0x${i}`,
            }),
          )
          .then(
            () => 'held',
            (error: unknown) => (error instanceof ReservationError ? error.code : String(error)),
          ),
      ),
    );
    assert.equal(results.filter((r) => r === 'held').length, 10, JSON.stringify(results));
    assert.equal(results.filter((r) => r === 'INSUFFICIENT_BALANCE').length, 10);
    const { rows } = await db.query<{ total: string }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM base_wallet_reservations WHERE state = 'held'",
    );
    assert.equal(rows[0].total, '100');
  },
);

test(
  'the same holder reserving concurrently gets exactly one reservation',
  { skip: !POSTGRES },
  async (t) => {
    const db = await database(t);
    const ledger = slowLedger(1_000n);
    const ids = await Promise.all(
      Array.from({ length: 12 }, () =>
        db
          .transaction((tx) =>
            ledger.reserve(tx, {
              walletId: 'w-1',
              chainId: 84532,
              token: USDC,
              amount: 50n,
              holder: { kind: 'fleet_job', ref: 'job-1:1' },
              intentHash: '0xaa',
            }),
          )
          .then((r) => r.reservationId),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM base_wallet_reservations',
    );
    assert.equal(rows[0].n, 1);
  },
);
