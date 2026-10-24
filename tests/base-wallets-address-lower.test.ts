import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { registerBaseMigration } from '../server/base/schema.js';
import {
  baseWalletsAddressLowerMigration,
  registerBaseWalletsAddressLowerMigration,
} from '../server/base/pay/address-index-schema.js';
import { listMigrations, runMigrations } from '../server/migrations.js';

test('migration 247 adds the lower(address) index on base_wallets, idempotently', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec("CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');");
  registerBaseMigration();
  registerBaseWalletsAddressLowerMigration();
  registerBaseWalletsAddressLowerMigration();
  assert.equal(listMigrations().filter((m) => m.version === 247).length, 1);
  assert.equal(baseWalletsAddressLowerMigration.name, 'base_wallets_address_lower');
  await runMigrations(pg);

  const def = await pg.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'base_wallets_address_lower'",
  );
  assert.match(def.rows[0]!.indexdef, /ON public\.base_wallets USING btree \(lower\(address\)\)/);

  // The recipient lookup's own predicate (store.ts recipients()) can use it.
  await pg.exec('SET enable_seqscan = off');
  const plan = await pg.query<{ 'QUERY PLAN': string }>(
    "EXPLAIN SELECT wallet_id FROM base_wallets w WHERE lower(w.address) = lower('0xAbC')",
  );
  assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /base_wallets_address_lower/);

  // Running again is a no-op (an index built CONCURRENTLY by hand beforehand is kept).
  await pg.exec(baseWalletsAddressLowerMigration.sql);
});
