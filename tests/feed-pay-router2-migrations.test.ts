// Fee router 2 migrations together (docs/protocol/FEE_ROUTER_2.md): the app boots with 232 (ledger
// router starts), 233 (payment bounds at 100 USDC) and 234 (the pot target) registered at once, in
// version order, and the pot target column holds exactly 1 to 100 USDC.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';

test('migrations 232, 233 and 234 apply together on a fresh database, in order', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const { rows } = await app.city.db.query<{ version: number | string; name: string }>(
    'SELECT version, name FROM schema_migrations WHERE version IN (232, 233, 234) ORDER BY version',
  );
  assert.deepEqual(
    rows.map((r) => [Number(r.version), r.name]),
    [
      [232, 'protocol_fee_router_starts'],
      [233, 'feed_pay_router2_caps'],
      [234, 'feed_pay_float_target'],
    ],
  );
});

test('migration 234: float_target_raw is nullable and bounded to 1..100 USDC', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const { rows } = await app.city.db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'c' AND c.conrelid = 'feed_pay_agent_settings'::regclass
        AND a.attname = 'float_target_raw'`,
  );
  assert.equal(rows.length, 1, 'one CHECK on float_target_raw');
  assert.match(rows[0]!.def, /IS NULL/);
  assert.match(rows[0]!.def, />= \(?1000000\)?/);
  assert.match(rows[0]!.def, /<= \(?100000000\)?/);
});
