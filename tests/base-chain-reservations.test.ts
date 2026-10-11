import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../server/database.js';
import { BASE_MIGRATION_SQL, BASE_PAYMENTS_MIGRATION_SQL } from '../server/base/schema.js';
import { createReservationLedger, ReservationError } from '../server/base/chain/reservations.js';
import { NATIVE_ETH, type Address } from '../shared/base/chains.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const WALLET_ADDRESS = '0x1111111111111111111111111111111111111111';

async function setup(
  t: { after: (fn: () => Promise<unknown>) => void },
  balances: Record<string, bigint>,
  read = { block: 1_000n },
) {
  const pg = await PGlite.create('memory://');
  t.after(() => pg.close());
  await pg.exec(
    "CREATE TABLE operators (id text PRIMARY KEY); INSERT INTO operators VALUES ('ws-1');",
  );
  await pg.exec(BASE_MIGRATION_SQL);
  await pg.exec(BASE_PAYMENTS_MIGRATION_SQL);
  await pg.query(
    `INSERT INTO base_wallets (wallet_id, agent_id, operator_id, chain_id, address, owner_address,
       spender_address, spender_key_ref, derivation, state, created_at, updated_at)
     VALUES ('w-1','a-1','ws-1',84532,$1,$1,$1,'v1:k','{}','derived',0,0)`,
    [WALLET_ADDRESS],
  );
  const db: Database = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (action) => pg.transaction((tx) => action(tx as never)),
    close: () => pg.close(),
  };
  const ledger = createReservationLedger({
    chainId: 84532,
    balanceOf: async (_address, token) => ({
      balance: balances[token.toLowerCase()] ?? 0n,
      blockNumber: read.block,
    }),
    now: () => 1_000,
  });
  return { db, ledger, balances, read };
}

const base = { walletId: 'w-1', chainId: 84532, token: USDC, intentHash: '0xaa' };

test('reserve: fails closed on balance minus held; idempotent per holder; conflicts refused', async (t) => {
  const { db, ledger } = await setup(t, { [USDC.toLowerCase()]: 100n });
  const a = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 60n, holder: { kind: 'payment', ref: 'p-1' } }),
  );
  assert.equal(a.state, 'held');
  assert.equal(a.amount, 60n);

  // Same holder, same request → the same reservation, no double hold.
  const again = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 60n, holder: { kind: 'payment', ref: 'p-1' } }),
  );
  assert.equal(again.reservationId, a.reservationId);

  // Same holder, different amount or intent → conflict.
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 61n, holder: { kind: 'payment', ref: 'p-1' } }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'RESERVATION_CONFLICT',
  );

  // 100 balance − 60 held = 40 available: 41 refused, 40 accepted.
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 41n, holder: { kind: 'fleet_job', ref: 'job-1' } }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'INSUFFICIENT_BALANCE',
  );
  await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 40n, holder: { kind: 'fleet_job', ref: 'job-1' } }),
  );

  // Tokens are separate: native ETH has its own balance.
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, {
        ...base,
        token: NATIVE_ETH,
        amount: 1n,
        holder: { kind: 'payment', ref: 'p-2' },
      }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'INSUFFICIENT_BALANCE',
  );
});

test('concurrent reserves serialize: never more held than the balance', async (t) => {
  const { db, ledger } = await setup(t, { [USDC.toLowerCase()]: 100n });
  const attempts = Array.from({ length: 10 }, (_, i) =>
    db
      .transaction((tx) =>
        ledger.reserve(tx, { ...base, amount: 30n, holder: { kind: 'payment', ref: `p-${i}` } }),
      )
      .then(
        () => 'held',
        (e: ReservationError) => e.code,
      ),
  );
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r === 'held').length, 3);
  assert.equal(results.filter((r) => r === 'INSUFFICIENT_BALANCE').length, 7);
});

test('consume and release: strict, idempotent transitions; released funds become available again', async (t) => {
  const { db, ledger, balances } = await setup(t, { [USDC.toLowerCase()]: 150n });
  const r = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 100n, holder: { kind: 'payment', ref: 'p-1' } }),
  );
  // The spend is final at block 500 (before the read at 1,000), so the balance already shows it.
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status, block_number, created_at, updated_at)
     VALUES ('o-1','op-1','0xaa','transfer',84532,'final',500,0,0)`,
  );
  balances[USDC.toLowerCase()] = 50n;
  const consumed = await db.transaction((tx) => ledger.consume(tx, r.reservationId, 'op-1'));
  assert.equal(consumed.state, 'consumed');
  assert.equal(
    (await db.transaction((tx) => ledger.consume(tx, r.reservationId, 'op-1'))).state,
    'consumed',
  );
  await assert.rejects(
    db.transaction((tx) => ledger.consume(tx, r.reservationId, 'op-2')),
    /consumed/,
  );
  await assert.rejects(
    db.transaction((tx) => ledger.release(tx, r.reservationId)),
    /consumed/,
  );

  const s = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 50n, holder: { kind: 'payment', ref: 'p-2' } }),
  );
  // While held, nothing more fits: 50 balance − 50 held.
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 1n, holder: { kind: 'payment', ref: 'p-x' } }),
    ),
    /does not cover/,
  );
  assert.equal(
    (await db.transaction((tx) => ledger.release(tx, s.reservationId))).state,
    'released',
  );
  // Released funds are available again.
  await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 50n, holder: { kind: 'payment', ref: 'p-y' } }),
  );
  assert.equal(
    (await db.transaction((tx) => ledger.release(tx, s.reservationId))).state,
    'released',
  );
  await assert.rejects(
    db.transaction((tx) => ledger.consume(tx, s.reservationId, 'op-3')),
    /released/,
  );
  await assert.rejects(
    db.transaction((tx) => ledger.release(tx, 'missing')),
    /No such reservation/,
  );
});

test('invalid input is refused before touching the database', async (t) => {
  const { db, ledger } = await setup(t, { [USDC.toLowerCase()]: 100n });
  for (const amount of [0n, -1n, 2n ** 256n])
    await assert.rejects(
      db.transaction((tx) =>
        ledger.reserve(tx, { ...base, amount, holder: { kind: 'payment', ref: 'x' } }),
      ),
      /positive integer/,
    );
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, {
        ...base,
        walletId: 'nope',
        amount: 1n,
        holder: { kind: 'payment', ref: 'x' },
      }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'WALLET_NOT_FOUND',
  );
});

test('a closed reservation is never handed back as new; other networks are refused', async (t) => {
  const { db, ledger } = await setup(t, { [USDC.toLowerCase()]: 100n });
  const holder = { kind: 'fleet_job' as const, ref: 'job-1:1' };
  const r = await db.transaction((tx) => ledger.reserve(tx, { ...base, amount: 10n, holder }));
  await db.transaction((tx) => ledger.consume(tx, r.reservationId, 'op-1'));
  await assert.rejects(
    db.transaction((tx) => ledger.reserve(tx, { ...base, amount: 10n, holder })),
    (e: unknown) => e instanceof ReservationError && e.code === 'RESERVATION_CLOSED',
  );
  const s2 = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 10n, holder: { ...holder, ref: 'job-1:2' } }),
  );
  await db.transaction((tx) => ledger.release(tx, s2.reservationId));
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 10n, holder: { ...holder, ref: 'job-1:2' } }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'RESERVATION_CLOSED',
  );
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, {
        ...base,
        chainId: 8453,
        amount: 1n,
        holder: { kind: 'payment', ref: 'p-9' },
      }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'WRONG_NETWORK',
  );
});

test('a lagging balance read never gives spent funds back', async (t) => {
  const { db, ledger, balances, read } = await setup(
    t,
    { [USDC.toLowerCase()]: 100n },
    { block: 90n },
  );
  const r = await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 70n, holder: { kind: 'payment', ref: 'p-1' } }),
  );
  // The spend lands final at block 100.
  await db.query(
    `INSERT INTO base_chain_ops (op_id, idempotency_key, intent_hash, kind, chain_id, status, block_number, created_at, updated_at)
     VALUES ('o-1','op:p-1','0xaa','transfer',84532,'final',100,0,0)`,
  );
  await db.transaction((tx) => ledger.consume(tx, r.reservationId, 'op:p-1'));

  // An RPC still at block 90 reports the old balance of 100: the consumed 70 still counts.
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 31n, holder: { kind: 'payment', ref: 'p-2' } }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'INSUFFICIENT_BALANCE',
  );
  await db.transaction((tx) =>
    ledger.reserve(tx, { ...base, amount: 30n, holder: { kind: 'payment', ref: 'p-3' } }),
  );

  // Once the read is at or after block 100, the debit is in the balance itself (100 − 70 = 30, minus 30 held).
  read.block = 100n;
  balances[USDC.toLowerCase()] = 30n;
  await assert.rejects(
    db.transaction((tx) =>
      ledger.reserve(tx, { ...base, amount: 1n, holder: { kind: 'payment', ref: 'p-4' } }),
    ),
    (e: unknown) => e instanceof ReservationError && e.code === 'INSUFFICIENT_BALANCE',
  );
});
