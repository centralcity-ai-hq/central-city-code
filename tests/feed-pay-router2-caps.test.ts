import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';

// Migration 233 (Operation Fee Contract): the database bounds of one Feed payment are fee router 2's
// 100 USDC, not router 1's 0.10 USDC. The application still enforces 0.10 unless router 2 is on.

const CAPPED = [
  ['feed_pay_calls', 'feed_pay_calls_max_amount_raw_check'],
  ['feed_pay_calls', 'feed_pay_calls_amount_raw_check'],
  ['feed_pay_calls', 'feed_pay_calls_total_cap'],
  ['feed_pay_agent_settings', 'feed_pay_agent_settings_per_call_max_raw_check'],
  ['city_offers', 'city_offers_price_raw_check'],
] as const;

test('migration 233: every 0.10 USDC payment CHECK now bounds at 100 USDC, nothing left at 0.10', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const { rows } = await app.city.db.query<{ table: string; name: string; def: string }>(
    `SELECT c.conrelid::regclass::text AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.contype = 'c'
        AND c.conrelid::regclass::text IN ('feed_pay_calls', 'feed_pay_agent_settings', 'city_offers')`,
  );
  for (const [table, name] of CAPPED) {
    const found = rows.find((r) => r.table === table && r.name === name);
    assert.ok(found, `${table}.${name} exists`);
    assert.match(found.def, /100000000/, `${name} bounds at 100 USDC: ${found.def}`);
  }
  for (const r of rows)
    assert.doesNotMatch(
      r.def,
      // Router 1 sized bounds: 0.10 USDC (100000) for amounts, 0.01 USDC (10000) for a fee.
      /<= \(?(?:100000|10000)\)?(?!\d)/,
      `${r.table}.${r.name} still at 0.10: ${r.def}`,
    );
  const fee = rows.find((r) => r.name === 'feed_pay_calls_fee_raw_check');
  assert.ok(fee, 'fee constraint exists');
  assert.match(fee.def, /<= \(?10000000\)?/, 'a 100 USDC included call stores its 10 USDC fee');
  // The fee-included minimum of an offer stays 0.05 USDC.
  assert.match(rows.find((r) => r.name === 'city_offers_price_raw_check')!.def, />= \(?50000\)?/);
});
