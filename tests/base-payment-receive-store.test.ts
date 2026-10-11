import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import {
  createReceiveStore,
  RECEIVE_RECONCILE_SQL,
  RECEIVE_SQL,
} from '../server/base/payments/receive-store.js';
import { BASE_TABLES } from '../server/base/schema.js';

test('receive claim binds an external authorization globally and never reacquires after restart', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators(id text PRIMARY KEY); INSERT INTO operators VALUES ('one'),('two');",
  );
  await pg.exec(RECEIVE_SQL);
  await pg.exec(RECEIVE_RECONCILE_SQL);
  assert.ok(BASE_TABLES.includes('base_x402_receipts'));
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const store = createReceiveStore(db);
  const b = {
    workspaceId: 'one',
    resource: 'resource-one',
    chainId: 84532,
    token: `0x${'1'.repeat(40)}`,
    payer: `0x${'2'.repeat(40)}`,
    recipient: `0x${'3'.repeat(40)}`,
    nonce: `0x${'ab'.repeat(32)}`,
    amount: '10',
  };
  const first = await store.claim(b, { validBefore: '100', searchFromBlock: 7n });
  assert.equal(first.acquired, true);
  assert.equal((await createReceiveStore(db).claim(b)).acquired, false);
  for (const changed of [
    { workspaceId: 'two' },
    { resource: 'other' },
    { amount: '11' },
    { recipient: `0x${'4'.repeat(40)}` },
  ])
    await assert.rejects(store.claim({ ...b, ...changed }), /RECEIVE_BINDING_CONFLICT/);
  const hash = `0x${'cd'.repeat(32)}`;
  assert.equal(await store.reconcile('two', first.receiptId, hash), false);
  assert.equal(await store.reconcile('one', first.receiptId, hash), true);
  assert.equal(await store.reconcile('one', first.receiptId, `0x${'ef'.repeat(32)}`), false);
  assert.equal(await store.reconcile('one', first.receiptId, null), true);
  const resumed = await store.claim(b);
  assert.equal(resumed.acquired, false);
  assert.equal(resumed.transaction, hash);
  assert.equal(resumed.state, 'reconciling');
  for (const assignment of [
    "resource='other'",
    'amount=11',
    "operator_id='two'",
    "nonce='0x'",
    "recipient='0x'",
    "receipt_id='other'",
    'valid_before=101',
    'valid_before=NULL',
    'search_from_block=8',
  ])
    await assert.rejects(
      pg.query(`UPDATE base_x402_receipts SET ${assignment} WHERE receipt_id=$1`, [
        first.receiptId,
      ]),
      /immutable/,
    );
  await assert.rejects(
    pg.query('UPDATE base_x402_receipts SET transaction_hash=$1 WHERE receipt_id=$2', [
      `0x${'AB'.repeat(32)}`,
      first.receiptId,
    ]),
    /check constraint/,
  );
  await assert.rejects(
    store.claim({ ...b, nonce: `0x${'ff'.repeat(32)}`, resource: 'x'.repeat(2049) }),
  );
  await pg.exec(RECEIVE_SQL); // Installation remains repeatable without dropping existing rows.
  assert.equal((await store.claim(b)).acquired, false);
});
