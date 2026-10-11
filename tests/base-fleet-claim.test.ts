import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { claimFleetItem } from '../server/base/fleet/claim.js';

test('claims expire, fence increases, and cancelled attempted work stays reconcilable', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE base_fleet_jobs(job_id text primary key, operator_id text, chain_id int,
      registration_mode text, state text, expires_at bigint);
      CREATE TABLE base_fleet_items(job_id text, ordinal int, stage text, agent_id text,
      operation_key text, intent_hash text, attempted boolean, fence bigint, batch_no int,
      status text, lease_owner text, lease_expires_at bigint, next_retry_at bigint,
      refused_at bigint, updated_at bigint, PRIMARY KEY(job_id,ordinal,stage));
      INSERT INTO base_fleet_jobs VALUES ('test-job','test-workspace',31337,'immediate','running',10000);
      INSERT INTO base_fleet_items VALUES ('test-job',0,'wallet','test-agent','test-op','test-intent',
        false,0,NULL,'pending',NULL,NULL,NULL,NULL,0);
      INSERT INTO base_fleet_items VALUES ('test-job',0,'registration','test-agent','test-register','test-intent',
        false,0,NULL,'pending',NULL,NULL,NULL,NULL,0);`);
    const db = pg as unknown as Database;
    const first = await claimFleetItem(db, 'test-job', 'worker-a', 1000, 1000);
    assert.equal(first?.fence, '1');
    assert.equal(first?.item.stage, 'wallet');
    await pg.exec("UPDATE base_fleet_items SET status='unknown' WHERE stage='wallet'");
    assert.equal(await claimFleetItem(db, 'test-job', 'worker-b', 1500, 1000), null);
    const second = await claimFleetItem(db, 'test-job', 'worker-b', 2000, 1000);
    assert.equal(second?.fence, '2');
    await pg.exec(
      "UPDATE base_fleet_jobs SET state='cancelling'; UPDATE base_fleet_items SET attempted=true,status='unknown',refused_at=2001 WHERE stage='wallet'",
    );
    const third = await claimFleetItem(db, 'test-job', 'worker-c', 3000, 1000);
    assert.equal(third?.fence, '3');
    assert.equal(third?.item.attempted, true);
    await pg.exec("UPDATE base_fleet_items SET status='final' WHERE stage='wallet'");
    assert.equal(await claimFleetItem(db, 'test-job', 'worker-d', 4000, 1000), null);
    await pg.exec("UPDATE base_fleet_jobs SET state='running'");
    assert.equal(
      (await claimFleetItem(db, 'test-job', 'worker-d', 4000, 1000))?.item.stage,
      'registration',
    );
    await pg.exec("UPDATE base_fleet_items SET batch_no=1 WHERE stage='registration'");
    assert.equal(await claimFleetItem(db, 'test-job', 'worker-e', 5000, 1000), null);
  } finally {
    await pg.close();
  }
});
