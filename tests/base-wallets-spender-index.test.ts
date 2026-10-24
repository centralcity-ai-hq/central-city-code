import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { registerBaseMigration } from '../server/base/schema.js';
import {
  baseWalletsSpenderMigration,
  registerBaseWalletsSpenderMigration,
} from '../server/base/wallet/spender-index-schema.js';
import { listMigrations, runMigrations } from '../server/migrations.js';

test('migration 253 adds the (spender_address, chain_id) index on base_wallets, idempotently', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec("CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');");
  registerBaseMigration();
  registerBaseWalletsSpenderMigration();
  registerBaseWalletsSpenderMigration();
  assert.equal(listMigrations().filter((m) => m.version === 253).length, 1);
  assert.equal(baseWalletsSpenderMigration.name, 'base_wallets_spender');
  await runMigrations(pg);

  const def = await pg.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'base_wallets_spender'",
  );
  assert.match(
    def.rows[0]!.indexdef,
    /ON public\.base_wallets USING btree \(spender_address, chain_id\)/,
  );

  // The lookups' own predicate (identity-port.ts walletUsable(), payment-chain.ts) can use it.
  await pg.exec('SET enable_seqscan = off');
  const plan = await pg.query<{ 'QUERY PLAN': string }>(
    "EXPLAIN SELECT state FROM base_wallets WHERE spender_address = '0xAbC' AND chain_id = 8453",
  );
  assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /base_wallets_spender/);

  // Running again is a no-op (an index built CONCURRENTLY by hand beforehand is kept).
  await pg.exec(baseWalletsSpenderMigration.sql);
});
