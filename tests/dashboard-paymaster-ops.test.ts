import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ARC_MAINNET } from '../shared/chains.js';
import { createApp } from '../server/app.js';
import {
  PAYMASTER_OPS_BLOCKS,
  PAYMASTER_OPS_SETTLE_BLOCKS,
  paymasterOperations,
  stepPaymasterOperations,
} from '../server/dashboard/paymaster-ops.js';
import { createWalletsReader } from '../server/dashboard/wallets.js';

process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-dashboard-paymaster-ops-test-root-secret';

/** The paymaster's running total and the facilitators' counts. Synthetic data only. */
let op = 0;
async function settled(db: any, block: number, status = 'settled') {
  op++;
  await db.query(
    `INSERT INTO own_paymaster_reservations(user_op_hash,flow,protected,max_cost_wei,actual_cost_wei,
       settled_block,status,valid_until,created_at,updated_at)
     VALUES($1,'test',false,1,$2,$3,$4,0,0,0)`,
    [
      `0x${op.toString(16).padStart(64, '0')}`,
      status === 'settled' ? 1 : null,
      status === 'settled' ? block : null,
      status,
    ],
  );
}

test('the running total counts settled blocks once, in bounded steps', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db as any;
  assert.equal(await paymasterOperations(db), null);
  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), null, 'nothing settled yet');

  const start = 1_000_000;
  await settled(db, start);
  await settled(db, start + 10);
  await settled(db, start + 20, 'expired');
  // Beyond the first step.
  await settled(db, start + PAYMASTER_OPS_BLOCKS + 5);
  // Still inside the settling window of the newest block: not counted yet.
  const head = start + PAYMASTER_OPS_BLOCKS + 1000;
  await settled(db, head);

  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), 2);
  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), 3);
  // Nothing new is safe to count: repeating changes nothing.
  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), 3);
  // The newest block counts once the head has moved past the settling window.
  await settled(db, head + PAYMASTER_OPS_SETTLE_BLOCKS + 1);
  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), 4);
});

test('wallets carry facilitator transactions and paymaster operations', async () => {
  const read = createWalletsReader({
    chain: {
      ethOf: async () => 1n,
      depositOf: async () => 2n,
      nonceOf: async () => 77,
    },
    clock: () => 1_000,
    operations: async () => 5,
  });
  const { wallets } = await read();
  const by = (kind: string) => wallets.find((w) => w.kind === kind)!;
  assert.equal(by('facilitator').transactions, 77);
  assert.equal(by('public_facilitator').transactions, 77);
  assert.equal(by('paymaster').operations, 5);
  assert.equal(by('router1').transactions, undefined);
});

test('settled Arc operations never move the Base total or its watermark', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const db = app.city.db as any;
  await db.query(
    `INSERT INTO own_paymaster_reservations(user_op_hash,flow,protected,max_cost_wei,actual_cost_wei,
       settled_block,status,valid_until,created_at,updated_at,chain_id)
     VALUES($1,'test',false,1,1,900000000,'settled',0,0,0,$2)`,
    [`0x${'a'.repeat(64)}`, ARC_MAINNET],
  );
  await stepPaymasterOperations(db);
  assert.equal(await paymasterOperations(db), null);
});
