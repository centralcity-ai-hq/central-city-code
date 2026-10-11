import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createFleetLeaseUpdates } from '../server/base/fleet/lease-updates.js';
import type { Database } from '../server/database.js';
import type { FleetClaim } from '../server/base/fleet/worker.js';

test('lease mutations fence stale workers and retain refused operation state', async () => {
  const pg = new PGlite();
  try {
    // Minimal table fixture for this mutation contract; full migration integration is separate.
    await pg.exec(`CREATE TABLE base_fleet_jobs(job_id text primary key, state text, expires_at bigint, operator_id text, chain_id int);
      CREATE TABLE base_fleet_items(job_id text, ordinal int, stage text, operation_key text,
      intent_hash text, fence bigint, lease_expires_at bigint, attempted boolean, refused_at bigint,
      status text, updated_at bigint, agent_id text, batch_no int);
      INSERT INTO base_fleet_jobs VALUES ('test-job','running',2000,'test-workspace',31337);
      INSERT INTO base_fleet_items VALUES ('test-job',0,'wallet','test-op','test-intent',2,1500,false,NULL,'pending',0,'test-agent',NULL);`);
    const db = pg as unknown as Database;
    const store = createFleetLeaseUpdates(db, () => 1000);
    const claim: FleetClaim = {
      fence: '2',
      item: {
        jobId: 'test-job',
        ordinal: 0,
        stage: 'wallet',
        operationKey: 'test-op',
        intentHash: 'test-intent',
        workspaceId: 'test-workspace',
        chainId: 31337,
        agentId: 'test-agent',
        registrationMode: 'lazy',
        attempted: false,
      },
    };
    for (const override of [{ workspaceId: 'other' }, { chainId: 8453 }, { agentId: 'other' }]) {
      const foreign = { ...claim, item: { ...claim.item, ...override } };
      assert.equal(await store.begin(foreign), false);
      assert.equal(await store.refuse(foreign), false);
    }
    assert.equal(await store.begin({ ...claim, fence: '1' }), false);
    assert.equal(await store.refuse({ ...claim, fence: '1' }), false);
    await pg.exec('UPDATE base_fleet_items SET batch_no=1');
    assert.equal(await store.begin(claim), false);
    assert.equal(await store.refuse(claim), false);
    await pg.exec('UPDATE base_fleet_items SET batch_no=NULL');
    assert.equal(await store.begin(claim), true);
    assert.equal(await store.begin(claim), false);
    await pg.exec("UPDATE base_fleet_items SET status = 'unknown'");
    assert.equal(await store.refuse(claim), true);
    const row = (
      await pg.query<{ status: string; attempted: boolean; refused_at: number }>(
        'SELECT status,attempted,refused_at FROM base_fleet_items',
      )
    ).rows[0];
    assert.equal(row.status, 'unknown');
    assert.equal(row.attempted, true);
    assert.equal(Number(row.refused_at), 1000);
    assert.equal(await createFleetLeaseUpdates(db, () => 1500).refuse(claim), false);
    await pg.exec(
      "UPDATE base_fleet_items SET attempted=false, refused_at=NULL, status='pending'; UPDATE base_fleet_jobs SET state='cancelling'",
    );
    assert.equal(await store.begin(claim), false);
    await pg.exec("UPDATE base_fleet_jobs SET state='running',expires_at=1000");
    assert.equal(await store.begin(claim), false);
  } finally {
    await pg.close();
  }
});
