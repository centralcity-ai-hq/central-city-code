import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { backupDatabase } from '../server/recovery.js';

test('backup: the sponsor ETH send log (migration 306) is recognized and never exported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'city-sponsor-eth-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const app = await createApp({ dataDir: data, startWorkers: false });
  await app.close();
  const marker = `0x${'ab'.repeat(32)}`;
  const db = await PGlite.create(data);
  try {
    await db.query(
      `INSERT INTO owner_sponsor_eth_sends
         (account_id, chain_id, from_address, to_address, value_wei, nonce, tx_hash, state, created_at, updated_at)
       VALUES ('owner', 8453, $1, $1, 1, 0, $2, 'mined', 0, 0)`,
      [`0x${'11'.repeat(20)}`, marker],
    );
  } finally {
    await db.close();
  }
  const backup = join(root, 'snapshot.json');
  await backupDatabase(data, backup);
  const text = await readFile(backup, 'utf8');
  assert.ok(!text.includes(marker));
  assert.ok(!text.includes('owner_sponsor_eth_sends'));
});
