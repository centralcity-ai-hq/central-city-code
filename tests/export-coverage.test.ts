import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { EXPORT_COVERAGE } from '../server/export-coverage.js';
import { EXPORT_EXCLUDED } from '../shared/data-export.js';

test('every table with account records is exported or listed as not included', async (t) => {
  const app = await createApp({ dataDir: 'memory://', startWorkers: false });
  t.after(() => app.close());
  const tables = (
    await app.city.db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('operator_id','owner_id','owner_account_id')
        ORDER BY table_name`,
    )
  ).rows.map((row) => row.table_name);
  const missing = tables.filter((table) => !(table in EXPORT_COVERAGE));
  assert.deepEqual(missing, [], 'add these tables to server/export-coverage.ts');
  const stale = Object.keys(EXPORT_COVERAGE).filter((table) => !tables.includes(table));
  assert.deepEqual(stale, [], 'these tables no longer exist or hold no account column');
});

test('the settings page lists every group that is not in the file', () => {
  const used = new Set(Object.values(EXPORT_COVERAGE));
  for (const item of EXPORT_EXCLUDED) assert.ok(used.has(item.key), item.key);
  for (const group of used)
    if (group !== 'exported')
      assert.ok(
        EXPORT_EXCLUDED.some((item) => item.key === group),
        group,
      );
  const page = readFileSync(new URL('../src/settings/DataExport.tsx', import.meta.url), 'utf8');
  assert.match(page, /EXPORT_EXCLUDED\.map\(/);
  assert.doesNotMatch(page, /Rooms and messages aren’t included/);
});
