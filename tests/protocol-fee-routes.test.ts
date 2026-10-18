import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { PROTOCOL_FEE_LEDGER_SQL } from '../server/protocol/fees/ledger.js';
import { registerProtocolFeeRoutes } from '../server/protocol/fees/routes.js';
import {
  PROTOCOL_FEE_TIME_INDEX_SQL,
  protocolFeeTimeIndexMigration,
} from '../server/protocol/fees/time-index-schema.js';

const NOW = Date.UTC(2026, 9, 15, 12); // 2026-10-15 12:00 UTC
const day = (d: number, h = 0) => Math.floor(Date.UTC(2026, 9, d, h) / 1000);

async function setup(t: test.TestContext, enabled = true) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  let n = 0;
  const insert = async (
    time: number,
    gross: number,
    fee: number,
    finalized = true,
    chainId = 84532,
  ) => {
    n++;
    const h = (c: string) => `0x${c.repeat(64 - String(n).length)}${n}`.slice(0, 66);
    await db.query(
      `INSERT INTO protocol_fee_events (chain_id, tx_hash, log_index, emitter, source, kind, block_number,
         block_hash, block_time, payer, payee, ref, gross, fee, finalized, service_verified, created_at)
       VALUES ($1,$2,0,$3,'router',0,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,0)`,
      [
        chainId,
        h('a'),
        `0x${'4'.repeat(40)}`,
        n,
        h('b'),
        time,
        `0x${'1'.repeat(40)}`,
        `0x${'2'.repeat(40)}`,
        h('c'),
        gross,
        fee,
        finalized,
      ],
    );
  };
  const app = Fastify();
  const limited: string[] = [];
  registerProtocolFeeRoutes(app, {
    db,
    chainId: () => (enabled ? 84532 : null),
    clock: () => NOW,
    limit: async (key) => {
      limited.push(key);
    },
  });
  t.after(() => app.close());
  return { app, insert, limited };
}

test('flag off: 404 and nothing read', async (t) => {
  const { app, limited } = await setup(t, false);
  const res = await app.inject('/api/public/protocol/fees');
  assert.equal(res.statusCode, 404);
  assert.equal(limited.length, 0);
});

test('daily volume, fees and revenue from finalized rows only, as USDC strings', async (t) => {
  const { app, insert, limited } = await setup(t);
  await insert(day(14, 1), 90_000, 9_000);
  await insert(day(14, 23), 100_000, 10_000);
  await insert(day(15, 2), 60_000, 6_000);
  await insert(day(15, 3), 50_000, 5_000, false); // not finalized: excluded
  await insert(day(15, 4), 70_000, 7_000, true, 8453); // other chain: excluded
  await insert(day(10, 4), 40_000, 4_000); // outside a 2-day window
  const res = await app.inject('/api/public/protocol/fees?days=2');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['cache-control']), /max-age=60/);
  const body = res.json();
  assert.deepEqual(body.days, [
    {
      day: '2026-10-14',
      payments: 2,
      fee_count: 2,
      volume_usdc: '0.190000',
      fees_usdc: '0.019000',
      revenue_usdc: '0.019000',
    },
    {
      day: '2026-10-15',
      payments: 1,
      fee_count: 1,
      volume_usdc: '0.060000',
      fees_usdc: '0.006000',
      revenue_usdc: '0.006000',
    },
  ]);
  assert.deepEqual(body.totals, {
    payments: 3,
    fee_count: 3,
    volume_usdc: '0.250000',
    fees_usdc: '0.025000',
    revenue_usdc: '0.025000',
  });
  assert.equal(body.fee_rate, '0.10');
  // No scan has run in this test: the totals are labelled partial.
  assert.equal(body.history_complete, false);
  assert.equal(body.scanned_through_block, null);
  assert.equal(body.last_scan_at, null);
  assert.ok(limited[0].startsWith('ip:protocolfees:'));
  for (const key of ['payer', 'payee', 'ref', 'tx_hash', 'workspace'])
    assert.ok(!JSON.stringify(body).includes(key), `no ${key} in the public response`);
});

test('days must be an integer from 1 to 365', async (t) => {
  const { app } = await setup(t);
  for (const bad of ['0', '366', '-1', '1.5', 'abc', '9999'])
    assert.equal((await app.inject(`/api/public/protocol/fees?days=${bad}`)).statusCode, 400, bad);
  assert.equal((await app.inject('/api/public/protocol/fees?days=365')).statusCode, 200);
});

test('one cache key per window: unknown query keys and leading zeros are refused', async (t) => {
  const { app } = await setup(t);
  for (const url of [
    '/api/public/protocol/fees?x=1',
    '/api/public/protocol/fees?days=30&x=1',
    '/api/public/protocol/fees?days=030',
    '/api/public/protocol/fees?days=01',
    '/api/public/protocol/fees?days=30&days=30',
  ])
    assert.equal((await app.inject(url)).statusCode, 400, url);
  assert.equal((await app.inject('/api/public/protocol/fees')).statusCode, 200);
  assert.equal((await app.inject('/api/public/protocol/fees?days=30')).statusCode, 200);
});

test('migration 172: the daily totals read their window through the (chain_id, block_time) index', async (t) => {
  assert.equal(protocolFeeTimeIndexMigration.version, 172);
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  await pg.exec(PROTOCOL_FEE_TIME_INDEX_SQL);
  await pg.exec('SET enable_seqscan = off');
  const plan = (
    await pg.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT count(*) FROM protocol_fee_events
        WHERE chain_id = $1 AND block_time >= $2 AND block_time < $3 AND finalized`,
      [84532, day(1), day(15)],
    )
  ).rows
    .map((row) => row['QUERY PLAN'])
    .join('\n');
  assert.match(plan, /protocol_fee_events_time/);
});

test('totals, scan progress and history_complete come from one read-only REPEATABLE READ snapshot', async (t) => {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(PROTOCOL_FEE_LEDGER_SQL);
  const outside: string[] = [];
  const inside: string[] = [];
  let transactions = 0;
  const db: Database = {
    query: (sql, params) => (outside.push(sql), pg.query(sql, params) as never),
    exec: (sql) => pg.exec(sql),
    transaction: (action) =>
      pg.transaction((tx) => {
        transactions++;
        return action({
          query: (sql: string, params?: unknown[]) => (inside.push(sql), tx.query(sql, params)),
          exec: (sql: string) => tx.exec(sql),
        } as never);
      }),
    close: () => pg.close(),
  };
  await pg.query(
    `INSERT INTO protocol_fee_scan_state (chain_id, next_block, finalized_through, caught_up, updated_at)
     VALUES (84532, 101, 90, true, $1)`,
    [NOW],
  );
  const app = Fastify();
  registerProtocolFeeRoutes(app, {
    db,
    chainId: () => 84532,
    clock: () => NOW,
    limit: async () => {},
  });
  t.after(() => app.close());
  const res = await app.inject('/api/public/protocol/fees');
  assert.equal(res.statusCode, 200);
  assert.equal(transactions, 1);
  assert.deepEqual(outside, [], 'no ledger read outside the snapshot');
  assert.equal(inside[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  assert.equal(inside.length, 4);
  assert.ok(inside.slice(1).some((sql) => /protocol_fee_events/.test(sql)));
  assert.ok(inside.slice(1).some((sql) => /caught_up/.test(sql)));
  const body = res.json();
  assert.equal(body.history_complete, true);
  assert.equal(body.finalized_through_block, '90');
  assert.equal(body.scanned_through_block, '100');
});
