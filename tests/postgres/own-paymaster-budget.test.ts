import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { postgresDatabase } from '../../server/database.js';
import {
  BudgetError,
  ownPaymasterBudget,
  ownPaymasterBudgetMigration,
} from '../../server/base/chain/own-paymaster-budget.js';

// Operation Paymaster's spending gate on real PostgreSQL: two separate pools act as
// two server instances; the budget row lock must admit exactly the headroom, however the requests
// interleave. Explicit opt-in, loopback-only disposable database (same harness rules as the other
// tests/postgres suites). Never accepts a hosted URL.
const connection = process.env.CITY_EXPIRY_PG_TEST_URL;
const MILLI = 10n ** 15n;
const NOW = 1_792_800_000_000;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  assert.ok(connection);
  const url = new URL(connection);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/cc_expiry_synthetic');
  const admin = new Pool({ connectionString: connection, max: 2 });
  const schema = `pm_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const replica = () =>
    postgresDatabase(
      new Pool({
        connectionString: connection,
        max: 8,
        options: `-c search_path=${schema} -c statement_timeout=10000`,
      }),
    );
  const a = replica();
  const b = replica();
  t.after(async () => {
    await a.close();
    await b.close();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await a.query(ownPaymasterBudgetMigration.sql);
  return { a, b };
}

test(
  'real PostgreSQL: the paymaster budget lock across two instances',
  { skip: !connection, timeout: 60000 },
  async (t) => {
    await t.test(
      '16 concurrent 0.001 requests on 0.005 headroom: exactly 5 admitted',
      async (t) => {
        const { a, b } = await fixture(t);
        // Deposit 0.055 = protected 0.05 + 0.005 of ordinary headroom.
        const deposit = async () => ({ wei: 55n * MILLI, block: 100n });
        const gates = [a, b].map((db) => ownPaymasterBudget({ db, deposit, now: () => NOW }));
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, (_, i) =>
            gates[i % 2]!.reserve({
              userOpHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
              flow: 'registration',
              maxCostWei: MILLI,
              validUntil: Math.floor(NOW / 1000) + 300,
            }),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
        for (const r of results)
          if (r.status === 'rejected')
            assert.ok(r.reason instanceof BudgetError && r.reason.reason === 'protected_reserve');
        const rows = await a.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM own_paymaster_reservations',
        );
        assert.equal(rows.rows[0]!.n, 5);
      },
    );
  },
);
