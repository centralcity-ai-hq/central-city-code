import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ARC_MAINNET, ARC_TESTNET } from '../shared/chains.js';
import { createApp } from '../server/app.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-arc-chain-ids-test-root-secret';

const TABLES = [
  'base_wallets',
  'base_fleet_jobs',
  'base_x402_authorizations',
  'base_wallet_withdrawals',
  'base_pay_lookups',
  'base_wallet_payments',
  'base_agent_pay_consents',
  'base_rate_lookups',
  'base_x402_receipts',
  'protocol_fee_events',
  'protocol_fee_scan_state',
  'protocol_fee_router_starts',
];

test('the chain lists accept Arc, keep Base, and still refuse anything else', async (t) => {
  const database = await PGlite.create('memory://');
  const app = await createApp({
    database,
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const { rows } = await database.query<{ table: string; def: string }>(
    `SELECT conrelid::regclass::text AS table, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype = 'c' AND conrelid::regclass::text = ANY($1)
        AND pg_get_constraintdef(oid) LIKE '%chain_id%'`,
    [TABLES],
  );
  // Every check naming chains on each table, whatever it's called: an old one left behind would
  // refuse Arc later.
  assert.deepEqual([...new Set(rows.map((row) => row.table))].sort(), [...TABLES].sort());
  for (const row of rows) {
    assert.ok(row.def.includes(String(ARC_MAINNET)), row.table);
    assert.ok(row.def.includes(String(ARC_TESTNET)), row.table);
    assert.ok(row.def.includes('8453'), row.table);
    assert.ok(row.def.includes('84532'), row.table);
    assert.ok(row.def.includes('NOT VALID'), row.table);
  }
  const scan = (chain: number) =>
    database.query(
      'INSERT INTO protocol_fee_scan_state (chain_id, next_block, updated_at) VALUES ($1, 0, 0)',
      [chain],
    );
  await scan(ARC_MAINNET);
  await scan(ARC_TESTNET);
  await assert.rejects(scan(1), /chain_id_check/);
});
