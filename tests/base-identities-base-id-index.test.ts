import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../server/database.js';
import {
  BASE_IDENTITIES_BASE_ID_SQL,
  baseIdentitiesBaseIdMigration,
  registerBaseIdentitiesBaseIdMigration,
} from '../server/base/explorer/base-id-index-schema.js';
import { createOnBaseStore } from '../server/base/explorer/store.js';
import { listMigrations } from '../server/migrations.js';
import { add, setup } from './on-base-fixture.js';

test('migration 255: the Explorer list reads newest first through the base id index, same rows', async (t) => {
  registerBaseIdentitiesBaseIdMigration();
  registerBaseIdentitiesBaseIdMigration();
  assert.equal(listMigrations().filter((m) => m.version === 255).length, 1);
  assert.equal(baseIdentitiesBaseIdMigration.name, 'base_identities_base_id');

  const db = await setup(t);
  for (let n = 1; n <= 60; n++) await add(db, { n, kind: 'final', id: 100 + n });
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const traced: Database = {
    ...db,
    query: ((sql: string, params?: unknown[]) => {
      statements.push({ sql, params: params ?? [] });
      return db.query(sql, params as never);
    }) as Database['query'],
  };
  const store = createOnBaseStore(traced, { chainId: 8453 });
  const before = await store.list({});
  const listSql = statements.find((s) => /ORDER BY/.test(s.sql))!;

  await db.query(BASE_IDENTITIES_BASE_ID_SQL);
  const after = await store.list({});
  assert.deepEqual(after, before);
  assert.equal(before.items[0]!.row.baseId, '160');

  // With the index, the page is read in order (no sort over every registration).
  await db.query('SET enable_seqscan = off');
  await db.query('SET enable_sort = off');
  const plan = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${listSql.sql}`, listSql.params as never);
  const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(text, /base_identities_base_id/, text);

  // Running again is a no-op (an index built CONCURRENTLY by hand beforehand is kept).
  await db.query(BASE_IDENTITIES_BASE_ID_SQL);
});
