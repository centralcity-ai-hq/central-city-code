import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  BASE_MIGRATION_SQL,
  BASE_PAYMENTS_MIGRATION_SQL,
  BASE_SHARED_ADDITIONS_SQL,
  BASE_TABLES,
} from '../server/base/schema.js';

async function db(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL);
  await pg.exec(BASE_SHARED_ADDITIONS_SQL); // idempotent
  await pg.exec(`INSERT INTO base_wallets VALUES ('w1','a1','ws',84532,
    '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1)`);
  return pg;
}
const TOKEN = `0x${'a'.repeat(40)}`;

test('payments: failed is a terminal state; unknown states are still refused', async (t) => {
  const pg = await db(t);
  const pay = (id: string, state: string) =>
    pg.query(
      `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind, source_ref,
        payer_wallet_id, intent_version, intent_hash, idempotency_key, token_address,
        recipient_address, amount, kind, state, created_at, updated_at)
       VALUES ($1,'ws',84532,'ws','agent','a1','w1',1,'0xh',$1,$2,$3,25,'transfer',$4,1,1)`,
      [id, TOKEN, `0x${'b'.repeat(40)}`, state],
    );
  await pay('p1', 'failed');
  await pay('p2', 'paid');
  await assert.rejects(pay('p3', 'lost'), /check/i);
});

test('chain ops: submitted_block is optional and never negative', async (t) => {
  const pg = await db(t);
  const op = (key: string, block: number | null) =>
    pg.query(
      `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status,
         submitted_block, created_at, updated_at)
       VALUES ($1,$1,'0xh','transfer',84532,'submitted',$2,1,1)`,
      [key, block],
    );
  await op('o1', null);
  await op('o2', 123);
  await assert.rejects(op('o3', -1), /check/i);
});

test('x402 authorizations: one per intent, one per payer nonce, sane windows', async (t) => {
  const pg = await db(t);
  const auth = (
    id: string,
    nonce: string,
    after = 1,
    before = 2,
    token = TOKEN,
    from = `0x${'c'.repeat(40)}`,
  ) =>
    pg.query(
      `INSERT INTO base_x402_authorizations VALUES ($1,84532,$2,$3,$4,10,$5,$6,$7,'\\x00',1)`,
      [id, token, from, `0x${'d'.repeat(40)}`, after, before, nonce],
    );
  const n1 = `0x${'1'.repeat(64)}`;
  await auth('i1', n1);
  await assert.rejects(auth('i1', `0x${'2'.repeat(64)}`), /unique|duplicate/i);
  await assert.rejects(auth('i2', n1), /unique|duplicate/i);
  await assert.rejects(auth('i3', `0x${'3'.repeat(64)}`, 5, 5), /check/i);
  await assert.rejects(auth('i4', `0x${'4'.repeat(64)}`, 1, 2, `0x${'A'.repeat(40)}`), /check/i);
  // Case variants of the same payer or nonce are refused, so uniqueness cannot be bypassed.
  await assert.rejects(auth('i5', `0x${'e'.repeat(63)}E`), /check/i);
  await assert.rejects(
    auth('i6', `0x${'5'.repeat(64)}`, 1, 2, TOKEN, `0x${'C'.repeat(40)}`),
    /check/i,
  );
});

test('master workspaces: one row per workspace, short notes', async (t) => {
  const pg = await db(t);
  const add = (note: string) =>
    pg.query(
      "INSERT INTO base_master_workspaces (operator_id, added_by, note, created_at) VALUES ('ws','operations',$1,1)",
      [note],
    );
  await add('internal');
  await assert.rejects(add('again'), /unique|duplicate/i);
});

test('restricted tables are recognized (never exported)', () => {
  assert.ok(BASE_TABLES.includes('base_x402_authorizations'));
  assert.ok(BASE_TABLES.includes('base_master_workspaces'));
});
