import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { createFleetStore } from '../server/base/fleet/store.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_FLEET_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_FLEET_MANIFEST_SQL,
} from '../server/base/schema.js';
import { runFleetSlice } from '../server/base/fleet/worker.js';

test('migration83 durable worker reconciles after restart without duplicate submission and advances registration', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('test-workspace')",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_FLEET_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_FLEET_MANIFEST_SQL);
    await pg.exec(`INSERT INTO base_wallets VALUES ('test-wallet','test-agent','test-workspace',31337,
      '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1);
      INSERT INTO base_fleet_jobs(job_id,operator_id,chain_id,treasury_wallet_id,run_nonce,intent_hash,intent,signature,manifest_hash,registration_mode,expires_at,state,created_at,updated_at)
      VALUES ('test-job','test-workspace',31337,'test-wallet','1','test-intent','{}',decode('00','hex'),'test-manifest','immediate',10000,'running',0,0);
      INSERT INTO base_fleet_items(job_id,ordinal,stage,agent_id,operation_key,intent_hash,status,created_at,updated_at,owner_address,wallet_address,derivation_version)
      VALUES ('test-job',0,'wallet','test-agent','test-op','test-intent','pending',0,0,'0x${'2'.repeat(40)}','0x${'1'.repeat(40)}',1),
      ('test-job',0,'registration','test-agent','test-register','test-intent','pending',0,0,'0x${'2'.repeat(40)}','0x${'1'.repeat(40)}',1);`);

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

test('migration83 failed lookup before any send can recover after a definitive absent lookup', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('test-workspace')",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_FLEET_MIGRATION_SQL);
    await pg.exec(BASE_SHARED_ADDITIONS_SQL);
    await pg.exec(BASE_FLEET_MANIFEST_SQL);
    await pg.exec(`INSERT INTO base_wallets VALUES ('test-wallet','test-agent','test-workspace',31337,
      '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1);
      INSERT INTO base_fleet_jobs(job_id,operator_id,chain_id,treasury_wallet_id,run_nonce,intent_hash,intent,signature,manifest_hash,registration_mode,expires_at,state,created_at,updated_at)
      VALUES ('test-job','test-workspace',31337,'test-wallet','1','test-intent','{}',decode('00','hex'),'test-manifest','immediate',10000,'running',0,0);
      INSERT INTO base_fleet_items(job_id,ordinal,stage,agent_id,operation_key,intent_hash,status,created_at,updated_at,owner_address,wallet_address,derivation_version)
      VALUES ('test-job',0,'wallet','test-agent','test-op','test-intent','pending',0,0,'0x${'2'.repeat(40)}','0x${'1'.repeat(40)}',1),
      ('test-job',0,'registration','test-agent','test-register','test-intent','pending',0,0,'0x${'2'.repeat(40)}','0x${'1'.repeat(40)}',1);`);

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
