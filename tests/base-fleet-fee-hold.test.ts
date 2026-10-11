import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '../server/database.js';
import { holdFleetFee } from '../server/base/fleet/fee-hold.js';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_FLEET_MIGRATION_SQL,
} from '../server/base/schema.js';

test('fee holds persist, replay without double charging, and roll back with principal failures', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('w')",
    );
    await pg.exec(BASE_MIGRATION_SQL);
    await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
    await pg.exec(BASE_FLEET_MIGRATION_SQL);
    await pg.exec(`INSERT INTO base_wallets VALUES ('wallet','agent','w',31337,
      '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1);
      INSERT INTO base_fleet_jobs(job_id,operator_id,chain_id,treasury_wallet_id,run_nonce,intent_hash,intent,signature,manifest_hash,registration_mode,expires_at,state,created_at,updated_at)
      VALUES ('j','w',31337,'wallet','1','signed','{}',decode('00','hex'),'manifest','lazy',10000,'running',0,0);
      INSERT INTO base_fleet_fee_budgets VALUES ('j',150,0,10,'v1','{"markupBps":1000,"fixedPerOpWei":"3"}');
      INSERT INTO base_fleet_batches(job_id,batch_no,operation_key,intent_hash,state,created_at,updated_at)
      VALUES ('j',0,'op0','intent0','pending',0,0),('j',1,'op1','intent1','pending',0,0);`);
    const input = {
      jobId: 'j',
      workspaceId: 'w',
      chainId: 31337,
      batchNo: 0,
      operationKey: 'op0',
      intentHash: 'intent0',
      maxCostWei: 100n,
    };
    const run = (i = input, now = 1000) =>
      pg.transaction((tx) => holdFleetFee(tx as unknown as Transaction, i, () => now));
    await pg.exec(
      `UPDATE base_fleet_fee_budgets SET provider_terms='{"markupBps":0,"fixedPerOpWei":"0"}'`,
    );
    await assert.rejects(run({ ...input, maxCostWei: 0n }), /must be positive/);
    assert.deepEqual(
      (await pg.query('SELECT reserved_wei::text FROM base_fleet_fee_budgets')).rows,
      [{ reserved_wei: '0' }],
    );
    assert.deepEqual(
      (await pg.query('SELECT max_fee_reserved_wei::text FROM base_fleet_batches WHERE batch_no=0'))
        .rows,
      [{ max_fee_reserved_wei: '0' }],
    );
    await pg.exec(
      `UPDATE base_fleet_fee_budgets SET provider_terms='{"markupBps":1000,"fixedPerOpWei":"3"}'`,
    );
    // The rejected zero request acquired nothing; this is the first successful hold.
    assert.equal(await run(), 113n);
    assert.equal(await run(), 113n);
    assert.equal(await run({ ...input, maxCostWei: 90n }), 113n);
    await assert.rejects(run({ ...input, maxCostWei: 101n }), /conflicts/);
    await assert.rejects(run({ ...input, workspaceId: 'other' }), /admissible/);
    await assert.rejects(run({ ...input, intentHash: 'changed' }), /admissible/);
    await assert.rejects(run(input, 10000), /admissible/);
    for (const change of [
      'UPDATE base_fleet_batches SET attempted=true WHERE batch_no=0',
      'UPDATE base_fleet_batches SET refused_at=1 WHERE batch_no=0',
      "UPDATE base_fleet_jobs SET state='cancelling'",
    ]) {
      await pg.exec(change);
      await assert.rejects(run(), /admissible/);
      await pg.exec(
        "UPDATE base_fleet_batches SET attempted=false, refused_at=NULL; UPDATE base_fleet_jobs SET state='running'",
      );
    }
    // Simulate time spent acquiring locks; expiry must be sampled after the final lock.
    await assert.rejects(
      pg.transaction(async (tx) => {
        let clock = 1000;
        const delayed = {
          exec: tx.exec.bind(tx),
          async query(sql: string, params?: unknown[]) {
            const result = await tx.query(sql, params);
            if (sql.includes('FROM base_fleet_fee_budgets')) clock = 10000;
            return result;
          },
        } as unknown as Transaction;
        return holdFleetFee(delayed, input, () => clock);
      }),
      /admissible/,
    );
    const second = {
      ...input,
      batchNo: 1,
      operationKey: 'op1',
      intentHash: 'intent1',
      maxCostWei: 30n,
    };
    await assert.rejects(run(second), /exceeds/);
    await assert.rejects(
      pg.transaction(async (tx) => {
        await holdFleetFee(
          tx as unknown as Transaction,
          { ...second, maxCostWei: 10n },
          () => 1000,
        );
        throw new Error('principal reservation failed');
      }),
      /principal reservation failed/,
    );
    assert.deepEqual(
      (await pg.query('SELECT reserved_wei::text FROM base_fleet_fee_budgets')).rows,
      [{ reserved_wei: '113' }],
    );
    assert.deepEqual(
      (await pg.query('SELECT max_fee_reserved_wei::text FROM base_fleet_batches WHERE batch_no=1'))
        .rows,
      [{ max_fee_reserved_wei: '0' }],
    );
    await pg.exec("UPDATE base_fleet_batches SET state='unknown' WHERE batch_no=0");
    await assert.rejects(run(), /admissible/);
    assert.deepEqual(
      (await pg.query('SELECT reserved_wei::text FROM base_fleet_fee_budgets')).rows,
      [{ reserved_wei: '113' }],
    );
  } finally {
    await pg.close();
  }
});
