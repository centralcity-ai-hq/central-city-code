import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  BASE_FLEET_MIGRATION_SQL,
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
} from '../server/base/schema.js';

const TOKEN = `0x${'a'.repeat(40)}`;

async function db(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_FLEET_MIGRATION_SQL);
  await pg.exec(BASE_FLEET_MIGRATION_SQL); // idempotent
  await pg.exec(`INSERT INTO base_wallets VALUES ('w1','a1','ws',8453,
    '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1)`);
  return pg;
}
const job = (pg: PGlite, id: string, nonce: string) =>
  pg.query(
    `INSERT INTO base_fleet_jobs (job_id, operator_id, chain_id, treasury_wallet_id, run_nonce,
      intent_hash, intent, signature, manifest_hash, registration_mode, expires_at, state,
      created_at, updated_at)
     VALUES ($1,'ws',8453,'w1',$2,'0xh','{}','\\x00','0xm','immediate',9,'created',1,1)`,
    [id, nonce],
  );

test('fleet jobs: run nonce is unique per workspace', async (t) => {
  const pg = await db(t);
  await job(pg, 'j1', '1');
  await assert.rejects(job(pg, 'j2', '1'), /unique/i);
  await job(pg, 'j3', '2');
  await assert.rejects(job(pg, 'j4', '01'), /check/i); // non-canonical form of 1
  await assert.rejects(job(pg, 'j5', '-1'), /check/i);
  await assert.rejects(job(pg, 'j6', `1${'0'.repeat(78)}`), /check/i); // above uint256
});

test('fleet budgets: one ceiling per token, stored lowercase', async (t) => {
  const pg = await db(t);
  await job(pg, 'j1', '1');
  const budget = (token: string) =>
    pg.query(
      `INSERT INTO base_fleet_token_budgets (job_id, token, principal_ceiling) VALUES ('j1',$1,1)`,
      [token],
    );
  await budget(TOKEN);
  await assert.rejects(budget(TOKEN.toUpperCase().replace('0X', '0x')), /check/i);
});

test('fleet budgets: reserved + spent never exceed the signed ceiling', async (t) => {
  const pg = await db(t);
  await job(pg, 'j1', '1');
  await pg.query(
    `INSERT INTO base_fleet_token_budgets (job_id, token, principal_ceiling) VALUES ('j1',$1,100)`,
    [TOKEN],
  );
  await pg.query(
    `UPDATE base_fleet_token_budgets SET principal_reserved = 60, principal_spent = 40`,
  );
  await assert.rejects(
    pg.query(`UPDATE base_fleet_token_budgets SET principal_reserved = 61`),
    /check/i,
  );
  await pg.query(`INSERT INTO base_fleet_fee_budgets VALUES ('j1',10,0,0,'v1','{}')`);
  await assert.rejects(pg.query(`UPDATE base_fleet_fee_budgets SET reserved_wei = 11`), /check/i);
});

test('fleet batches and items: operation keys are unique', async (t) => {
  const pg = await db(t);
  await job(pg, 'j1', '1');
  const batch = (no: number, key: string) =>
    pg.query(
      `INSERT INTO base_fleet_batches (job_id, batch_no, operation_key, intent_hash, state,
        created_at, updated_at) VALUES ('j1',$1,$2,'0xh','pending',1,1)`,
      [no, key],
    );
  await batch(0, 'op0');
  await assert.rejects(batch(1, 'op0'), /unique/i);
  const item = (ord: number, stage: string, key: string) =>
    pg.query(
      `INSERT INTO base_fleet_items (job_id, ordinal, stage, agent_id, operation_key, intent_hash,
        batch_no, status, created_at, updated_at) VALUES ('j1',$1,$2,'a1',$3,'0xh',0,'pending',1,1)`,
      [ord, stage, key],
    );
  await item(0, 'wallet', 'i0w');
  await item(0, 'registration', 'i0r');
  await assert.rejects(item(1, 'wallet', 'i0w'), /unique/i);
});

test('fleet items: refusal is recorded apart from the operation state', async (t) => {
  const pg = await db(t);
  await job(pg, 'j1', '1');
  const item = (status: string) =>
    pg.query(
      `INSERT INTO base_fleet_items (job_id, ordinal, stage, agent_id, operation_key, intent_hash,
        status, refused_at, created_at, updated_at) VALUES ('j1',0,'wallet','a1','k','0xh',$1,5,1,1)`,
      [status],
    );
  await assert.rejects(item('refused'), /check/i);
  await item('unknown'); // refused, but its operation still needs reconciliation
});
