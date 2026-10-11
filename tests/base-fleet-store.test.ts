import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { createFleetStore } from '../server/base/fleet/store.js';
import { runFleetSlice } from '../server/base/fleet/worker.js';

test('durable worker reconciles after restart without duplicate submission and advances registration', async () => {
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
    let now = 1000;
    let sends = 0;
    const authority = { async authorize() {} };
    const first = createFleetStore(db, 'worker-a', () => now);
    const result = await runFleetSlice('test-job', {
      store: first,
      authority,
      adapter: {
        async reconcile() {
          return 'absent' as const;
        },
        async submit() {
          sends++;
          throw new Error('synthetic connection loss');
        },
      },
    });
    assert.equal(result.deferred, 1);
    assert.equal(sends, 1);
    now = 6000;
    const restarted = createFleetStore(db, 'worker-b', () => now);
    const recovered = await runFleetSlice('test-job', {
      store: restarted,
      authority,
      adapter: {
        async reconcile(item) {
          return item.stage === 'wallet' ? ('final' as const) : ('absent' as const);
        },
        async submit() {
          sends++;
          return 'final' as const;
        },
      },
    });
    assert.equal(recovered.final, 2);
    assert.equal(sends, 2); // One wallet attempt total, one registration attempt.
    assert.equal(await restarted.claim('test-job'), null);
    await pg.exec(
      "UPDATE base_fleet_items SET status='pending',attempted=false WHERE stage='registration'",
    );
    const stale = await restarted.claim('test-job');
    assert.ok(stale);
    await pg.exec('UPDATE base_fleet_jobs SET expires_at=100000');
    now += 30000;
    const replacement = await createFleetStore(db, 'worker-c', () => now).claim('test-job');
    assert.ok(replacement);
    await assert.rejects(restarted.settle(stale, 'final'), /lost ownership/);
  } finally {
    await pg.close();
  }
});

test('a failed lookup before any send can recover after a definitive absent lookup', async () => {
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
    let now = 1000;
    let sends = 0;
    const authority = { async authorize() {} };
    const first = await runFleetSlice('test-job', {
      store: createFleetStore(db, 'worker-a', () => now),
      authority,
      adapter: {
        async reconcile() {
          throw new Error('synthetic lookup failure');
        },
        async submit() {
          sends++;
          return 'final' as const;
        },
      },
    });
    assert.equal(first.deferred, 1);
    assert.equal(sends, 0);
    now = 6000;
    const retry = await runFleetSlice('test-job', {
      store: createFleetStore(db, 'worker-b', () => now),
      authority,
      adapter: {
        async reconcile() {
          return 'absent' as const;
        },
        async submit() {
          sends++;
          return 'final' as const;
        },
      },
    });
    assert.equal(retry.final, 2);
    assert.equal(retry.refused, 0);
    assert.equal(sends, 2);
  } finally {
    await pg.close();
  }
});
