import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } from '../server/base/schema.js';

async function db(t: { after: (fn: () => Promise<unknown>) => void }) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL); // idempotent
  await pg.exec(`INSERT INTO base_wallets VALUES ('w1','a1','ws',84532,
    '0x${'1'.repeat(40)}','0x${'2'.repeat(40)}','0x${'3'.repeat(40)}','v1:k1','{}','derived',1,1)`);
  return pg;
}
const TOKEN = `0x${'a'.repeat(40)}`;

test('reservations: positive amounts only, one per holder, wallet and token', async (t) => {
  const pg = await db(t);
  const insert = (id: string, amount: string, ref = 'p1') =>
    pg.query(
      `INSERT INTO base_wallet_reservations VALUES ($1,'w1',84532,$2,$3,'payment',$4,'0xh','held',NULL,1,1)`,
      [id, TOKEN, amount, ref],
    );
  await insert('r1', '1000000');
  await assert.rejects(insert('r2', '5'), /unique/i);
  await assert.rejects(insert('r3', '0', 'p2'), /check/i);
  await insert(
    'r4',
    '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    'p3',
  );
});

test('payments: idempotency key unique per workspace and chain, positive amounts', async (t) => {
  const pg = await db(t);
  const pay = (id: string, key: string, amount: string) =>
    pg.query(
      `INSERT INTO base_payments (payment_id, operator_id, chain_id, actor_id, source_kind, source_ref,
        payer_wallet_id, intent_version, intent_hash, idempotency_key, token_address,
        recipient_address, amount, kind, state, created_at, updated_at)
       VALUES ($1,'ws',84532,'ws','agent','a1','w1',1,'0xh',$2,$3,$4,$5,'transfer','created',1,1)`,
      [id, key, TOKEN, `0x${'b'.repeat(40)}`, amount],
    );
  await pay('p1', 'k1', '25');
  await assert.rejects(pay('p2', 'k1', '25'), /unique/i);
  await assert.rejects(pay('p4', 'k4', '0'), /check/i);
});
