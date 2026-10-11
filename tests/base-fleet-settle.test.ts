import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { claimFleetItem } from '../server/base/fleet/claim.js';
import { settleFleetItem } from '../server/base/fleet/settle.js';

test('settlement fences stale workers, preserves uncertain work, and protects terminal outcomes', async () => {
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
    assert.ok(first);
    assert.equal(await settleFleetItem(db, first, 'final', 2000), false);
    const second = await claimFleetItem(db, 'test-job', 'worker-b', 2000, 1000);
    assert.ok(second);
    assert.equal(await settleFleetItem(db, first, 'final', 2100), false);
    assert.equal(
      await settleFleetItem(
        db,
        { ...second, item: { ...second.item, workspaceId: 'foreign' } },
        'final',
        2100,
      ),
      false,
    );
    await pg.exec(
      "UPDATE base_fleet_jobs SET state='cancelling'; UPDATE base_fleet_items SET attempted=true,refused_at=2001 WHERE stage='wallet'",
    );
    assert.equal(await settleFleetItem(db, second, 'unknown', 2100, 1000), true);
    const state = (
      await pg.query(
        "SELECT attempted,refused_at,lease_owner,lease_expires_at,next_retry_at FROM base_fleet_items WHERE stage='wallet'",
      )
    ).rows[0] as Record<string, unknown>;
    assert.equal(state.attempted, true);
    assert.equal(Number(state.refused_at), 2001);
    assert.equal(state.lease_owner, null);
    assert.equal(state.lease_expires_at, null);
    assert.equal(Number(state.next_retry_at), 3100);
    assert.equal(await claimFleetItem(db, 'test-job', 'worker-c', 3099, 1000), null);
    const third = await claimFleetItem(db, 'test-job', 'worker-c', 3100, 1000);
    assert.ok(third);
    assert.equal(await settleFleetItem(db, third, 'final', 3101), true);
    assert.equal(await settleFleetItem(db, third, 'unknown', 3102), false);
    assert.equal(await claimFleetItem(db, 'test-job', 'worker-d', 3200, 1000), null);
    await pg.exec("UPDATE base_fleet_jobs SET state='running'");
    const registration = await claimFleetItem(db, 'test-job', 'worker-d', 3200, 1000);
    assert.ok(registration);
    assert.equal(registration.item.stage, 'registration');
    await pg.exec("UPDATE base_fleet_items SET batch_no=1 WHERE stage='registration'");
    assert.equal(await settleFleetItem(db, registration, 'failed', 3201), false);
    await pg.exec("UPDATE base_fleet_items SET batch_no=NULL WHERE stage='registration'");
    assert.equal(await settleFleetItem(db, registration, 'failed', 3202), true);
    assert.equal(await settleFleetItem(db, registration, 'final', 3203), false);
  } finally {
    await pg.close();
  }
});
